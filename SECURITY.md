# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in BeeTalk, please **do not** open a public GitHub issue. Instead, email your findings to the maintainers with details about the vulnerability.

**Please include:**
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

### Security Response Timeline
- **Acknowledgment**: Within 48 hours
- **Assessment & Fix**: Within 7 days (severity dependent)
- **Disclosure**: Coordinated disclosure after patch is released

## Security Practices

### Credential Management
- **Passwords** are stored securely using the OS credential manager (via `keytar`)
  - Windows: Windows Credential Manager
  - macOS: Keychain
  - Linux: Secret Service or Pass
- **Plaintext passwords are never stored** on disk

### Network Security
- All XMPP connections use **TLS with certificate validation** enabled
- No insecure fallbacks to unencrypted connections
- Connection details are only stored locally (server, port, username)

### Message Privacy
- BeeTalk is a **client application only** — messages are transmitted to and stored on the XMPP server
- Message encryption depends on the XMPP server's capabilities and configuration
- BeeTalk does not implement end-to-end encryption (E2E relies on XMPP server/extensions like OMEMO)

### Data Storage
- **Local storage** contains:
  - Account list (username, server, port) — passwords excluded
  - Joined rooms list (per account)
  - Last 50 message previews for tabs
  - UI preferences (theme, notifications)
- **No telemetry or analytics** — all data stays local
- **No cloud sync** — data is device-only

## Known Limitations

- BeeTalk relies on the XMPP server for security features (S2S encryption, user authentication)
- Self-signed XMPP server certificates will cause connection failures (by design)
- Credential storage security depends on OS credential manager security
- Message history is limited to what the server provides (MAM - Message Archive Management)

## Dependencies

BeeTalk depends on several third-party packages. Security updates are applied regularly. Check `package.json` for the current dependency list.

**Key dependencies:**
- `@xmpp/client` — XMPP protocol implementation
- `electron` — Desktop application framework
- `keytar` — Secure credential storage

## Best Practices for Users

1. **Use XMPP servers you trust** — Your messages are encrypted in transit (TLS) but visible to the server operator
2. **Keep your system credential manager secure** — Your passwords are stored there
3. **Update BeeTalk regularly** — Security patches are released as updates
4. **Use strong passwords** — Follow your XMPP server's password policy
5. **Enable server-side message encryption** — If your XMPP server supports OMEMO or other E2E extensions

## Security Audits

This is a community-maintained project. Users and security researchers are welcome to audit the code and report findings.

If you maintain a security tool or maintain a distribution package, please reach out if you find security issues.
