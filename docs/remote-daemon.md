# Running the daemon on a server

Cycle's desktop app can show a daemon that runs on another machine. The daemon on the server is the
same one as on your computer, unchanged: it binds to loopback, checks `Host` and `Origin`, and
requires its connection token. The app reaches it through an ssh tunnel, so **no firewall port is
opened** and nothing listens beyond the server's own loopback.

## Run it

You start the daemon on the server yourself; Cycle does not start one over ssh. It needs Bun, a
checkout of this repository with its dependencies installed, a built page (`bun run build`, which
puts it in `apps/desktop/dist/renderer`, or point `CYCLE_UI_DIR` at one), `codex` on the `PATH`
(and `claude` for Claude Code sessions), and the agents signed in as that user.

A systemd user unit, `~/.config/systemd/user/cycle-daemon.service`:

```ini
[Unit]
Description=Cycle daemon

[Service]
WorkingDirectory=%h/cycle
Environment=CYCLE_HOME=%h/.cycle-codex
Environment=CYCLE_DAEMON_PORT=4747
ExecStart=/usr/local/bin/bun apps/daemon/src/main.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now cycle-daemon`, and
`loginctl enable-linger $USER` so it runs while you are logged out. `CYCLE_HOME` must be an
absolute path; it is where `daemon.json`, settings and sessions live on the server. If you use
another one, give the same path as the server's "Cycle home" in Settings, Remote servers.

## How Cycle connects

For the server you add (an `user@host` or a name from your `~/.ssh/config`), the app:

1. runs `ssh <target> cat <home>/daemon.json` and reads the page address, the token and the
   process id;
2. opens `ssh -N -L <port>:127.0.0.1:<port> <target>`;
3. checks `/health` through it, and warns in the sidebar when the daemon's version differs from the
   app's;
4. shows the server's page, with the token in the address's fragment.

The token changes each time the daemon starts, and is read again at each connection. It is never
written to disk by the app, and the page never sees ssh's output. To read the file yourself:

```sh
ssh me@server cat ~/.cycle-codex/daemon.json   # { url, pageUrl, token, pid, version }
```

Authentication is your own ssh config and agent. The app runs ssh with `BatchMode=yes`, so it never
waits for a password or passphrase: load the key into your agent first.

## Limits

- **The same port on both ends.** The daemon accepts only a `Host` naming its own port, so the
  tunnel uses the server's port here too. If that port is taken on your computer, the connection
  fails with a message; set a different `CYCLE_DAEMON_PORT` on the server. The daemon's checks are
  never widened to get around it.
- **First time, ssh once in a terminal.** `BatchMode` refuses to answer the unknown-host-key
  question, and the app never turns host key checking off. Run `ssh <target>`, accept the key, then
  connect from Settings.
- **Folders, files, git and terminals are the server's.** The folder chooser lists the server's
  folders through the daemon. Notifications, links and the app's own update stay on your computer.
- The daemon must be running: the app says so when `daemon.json` is missing or its process is gone.
