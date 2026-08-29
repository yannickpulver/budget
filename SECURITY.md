# Security

budget has no login and no user accounts by design. Anyone who can reach the
app can read and change the whole budget, so do not expose it to the internet.
Run it on localhost, on a private network such as Tailscale, or behind a
reverse proxy that handles authentication.

To report a vulnerability, open a private security advisory at
https://github.com/yannickpulver/budget/security/advisories/new. Please do not
open a public issue.
