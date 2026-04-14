# Privacy Policy

**Last updated:** 2026-04-14

BeeTalk is an open-source XMPP chat client. This privacy policy explains what data BeeTalk collects, how it's used, and your rights.

## TL;DR

- ✅ **No data collection** — BeeTalk doesn't track or collect user data
- ✅ **No telemetry** — No analytics, crash reports, or tracking
- ✅ **No servers** — BeeTalk is a client application (no BeeTalk-operated backend)
- ✅ **Local storage only** — All data stays on your device
- ✅ **Open source** — Code is transparent and auditable

## What Data BeeTalk Stores Locally

All data is stored **only on your device** in encrypted form:

### Account Information
- XMPP server address, port, and username
- Display name and presence status
- **Passwords are NOT stored on disk** — they're stored in your OS credential manager (Windows Credential Manager, macOS Keychain, or Linux Secret Service)

### Chat Data
- List of joined rooms (per account)
- Last 50 messages from each chat (for previews in the sidebar)
- Message timestamps
- Participant lists (for group chats)

### User Preferences
- Theme preference (light/dark)
- Notification settings
- Emoticon favorites (if applicable)

### No Collection
BeeTalk does **not**:
- Collect usage analytics
- Track user behavior
- Send crash reports
- Request permissions beyond what's needed to connect to XMPP
- Have access to your files unless you explicitly select them
- Connect to any BeeTalk-operated servers (BeeTalk has no backend)

## Data You Share With Your XMPP Server

When you use BeeTalk, your XMPP server operator can see:
- Your username and presence status (online/away/offline)
- Messages you send and receive (encrypted in transit with TLS)
- Room membership and room messages
- Your IP address (from connection logs)

**This is true for any XMPP client.** You control which XMPP server you connect to. Popular options include:
- **GSF Jabber** (goonfleet.com) — designed for EVE Online community
- **Self-hosted** — run your own XMPP server
- **Public XMPP servers** — various community-run servers

**Your choice of XMPP server determines your privacy.** Read your server's privacy policy.

## Credential Security

Your passwords are stored securely in your operating system's credential manager:
- **Windows:** Windows Credential Manager
- **macOS:** Keychain
- **Linux:** Secret Service or Pass

BeeTalk **never stores passwords on disk** in plaintext or retrievable format. They're encrypted by your OS.

**Your device's security determines credential security.** If someone gains admin/root access to your device, they could potentially access stored credentials (like any application).

## Third-Party Services

BeeTalk does not use third-party analytics, crash reporting, or advertising services.

**Optional integrations** (user choice):
- **XMPP servers** — You choose which server(s) to connect to
- **Custom emoji packs** — Downloaded from wherever you place them locally

## Data Retention

- **Messages**: Stored locally until you delete them. Your XMPP server may archive messages separately per its policy.
- **Account info**: Stored locally until you delete the account from BeeTalk
- **Credentials**: Stored in OS credential manager until manually deleted
- **Preferences**: Stored locally (deleted if you uninstall BeeTalk)

## Your Rights

- **Access**: You can see all data BeeTalk stores by browsing `%APPDATA%\BeeTalk` (Windows) or equivalent on other systems
- **Export**: You can export messages manually
- **Delete**: You can delete accounts, chats, or preferences from within BeeTalk
- **Audit**: The source code is available for security review — you can verify what it does

## Open Source & Transparency

BeeTalk is **100% open source**. You can:
- Review the full source code on GitHub
- Build from source yourself
- Audit the code for privacy/security issues
- Run your own modified version

If you find a privacy concern, please report it via `SECURITY.md`.

## Changes to This Policy

This policy may be updated. Significant changes will be noted in release notes.

## Questions?

If you have questions about this privacy policy, you can:
- Review the code on GitHub
- Check `SECURITY.md` for how to report concerns
- Open an issue (for non-sensitive questions)

---

**Important:** BeeTalk is a desktop application, not a service. This policy covers what the *application* does, not what your XMPP server does. Your XMPP server operator has access to your messages and metadata — this is inherent to how XMPP works. Choose your server carefully.
