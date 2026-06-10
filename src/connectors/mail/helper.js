// JXA helper for the Loom `mail` connector. Reads messages from Apple Mail
// (Mail.app) in a date range and prints them as JSON to stdout. `--box`
// selects which folders: "sent" (default) or "inbox".
//
// No network, no tokens — local Mail scripting, gated by the macOS Automation
// privacy permission (your terminal app must be allowed to control Mail).
//
// Run: osascript -l JavaScript helper.js --from YYYY-MM-DD --to YYYY-MM-DD [--box sent|inbox]

function run(argv) {
  function arg(name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  }

  const fromStr = arg('--from');
  const toStr = arg('--to');
  const box = arg('--box') || 'sent';
  if (!fromStr || !toStr) {
    throw new Error('usage: helper.js --from YYYY-MM-DD --to YYYY-MM-DD [--box sent|inbox]');
  }
  const from = new Date(fromStr + 'T00:00:00');
  const to = new Date(toStr + 'T23:59:59');

  const Mail = Application('Mail');
  Mail.includeStandardAdditions = true;

  // Folder names across English/Norwegian + Exchange variants.
  const SENT_RE = /sent|sendt|elementer/i;
  const INBOX_RE = /^(inbox|innboks)$/i;
  const isWanted = box === 'inbox' ? function (nm) { return INBOX_RE.test(nm); }
                                   : function (nm) { return SENT_RE.test(nm); };

  // Gather candidate mailboxes from every account.
  const candidates = [];
  let accounts = [];
  try {
    accounts = Mail.accounts();
  } catch (e) {
    accounts = [];
  }
  for (const acct of accounts) {
    let acctName = '';
    try {
      acctName = acct.name();
    } catch (e) {}
    let mboxes = [];
    try {
      mboxes = acct.mailboxes();
    } catch (e) {
      continue;
    }
    for (const mb of mboxes) {
      let nm = '';
      try {
        nm = mb.name();
      } catch (e) {
        continue;
      }
      if (isWanted(nm)) candidates.push({ mb, acctName, mboxName: nm });
    }
  }

  // Inbox messages are filtered on when they ARRIVED, sent on when they left.
  const dateProp = box === 'inbox' ? 'dateReceived' : 'dateSent';

  const out = [];
  for (const c of candidates) {
    let msgs = [];
    try {
      // `whose` is evaluated by Mail (far faster than iterating everything).
      const filter = {};
      filter[dateProp] = { '>': from };
      msgs = c.mb.messages.whose(filter)();
    } catch (e) {
      try {
        msgs = c.mb.messages();
      } catch (e2) {
        continue;
      }
    }
    for (const m of msgs) {
      let d = null;
      try {
        d = m[dateProp]();
      } catch (e) {
        continue;
      }
      if (!d || d < from || d > to) continue;

      let subject = '';
      let sender = '';
      try {
        subject = m.subject();
      } catch (e) {}
      try {
        sender = m.sender();
      } catch (e) {}
      let recipients = [];
      try {
        recipients = m.toRecipients().map(function (r) {
          try {
            return r.address();
          } catch (e) {
            return '';
          }
        });
      } catch (e) {}
      let id = '';
      try {
        id = '' + m.messageId();
      } catch (e) {}

      out.push({
        id: id,
        account: c.acctName,
        mailbox: c.mboxName,
        subject: subject || '',
        sender: sender || '',
        recipients: recipients.filter(Boolean),
        date: d.toISOString(),
      });
    }
  }

  return JSON.stringify(out);
}
