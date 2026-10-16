# Security

Parts Bin is an offline desktop app. It makes network requests only to check GitHub Releases for updates
(which can be turned off in Settings) and opens eBay links in your browser when you click them.

The window runs sandboxed with context isolation and no Node access; everything that touches the file system goes
through single-purpose IPC calls in `preload.js`. The camera is only requested by the label scanner.

If you find a vulnerability, please report it privately through GitHub's
"Report a vulnerability" button on the repository's Security tab rather than opening a public issue.
