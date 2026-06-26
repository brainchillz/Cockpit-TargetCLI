# Cockpit-TargetCLI

A [Cockpit](https://cockpit-project.org/) / 45Drives Houston web-UI module for
managing Linux LIO iSCSI targets through `targetcli` / `rtslib_fb`.

It provides a read-only view of the live LIO configuration (backstores,
targets, TPGs, LUNs, ACLs, portals) plus a set of **additive-only** management
actions, surfaced as a menu entry in the Cockpit web console.

## Status

Working proof-of-concept. Read path and guarded write (create) path are
implemented and tested against Cockpit 329.x on Rocky Linux 9.

## Features

- **Read-only viewer** — renders the live target tree via `rtslib_fb`
  (the same library `targetcli` uses), so no CLI screen-scraping.
- **Additive management** — create fileio backstores, iSCSI targets, network
  portals, initiator ACLs, and LUN mappings, each behind a confirmation step.

## Safety model

The write helper (`target-action.py3`) is deliberately constrained:

- **Additive only.** There is no delete / clear / modify code path.
- **Auto-backup.** Every mutating action snapshots
  `/etc/target/saveconfig.json` to a timestamped file under
  `/etc/target/backups/` before applying.
- **No-clobber.** Creates use rtslib `mode="create"`, which fails rather than
  overwrite or silently reuse an existing object.
- **Persisted.** Changes are written with `save_to_file()` so they survive
  reboot (restored at boot by the enabled `target.service`).

## Layout

```
targetcli/
  manifest.json      Cockpit menu registration
  index.html         Page shell
  main.js            Front-end (read render + action forms)
  style.css          Styling
  target-dump.py3    Read-only JSON dump of LIO state (rtslib_fb)
  target-action.py3  Additive write actions (rtslib_fb, auto-backup)
```

## Install

Copy the module into Cockpit's package directory on the target host:

```bash
sudo cp -r targetcli /usr/share/cockpit/targetcli
sudo restorecon -R /usr/share/cockpit/targetcli   # if SELinux is enforcing
```

Then open the Cockpit web console (`https://<host>:9090`) and select
**iSCSI Targets** from the menu.

### Requirements

- `cockpit` (tested with 329.x)
- `targetcli` / `python3-rtslib-fb`
- `target.service` enabled (for boot persistence)

## License

Licensed under the GNU General Public License v3.0 or later
([GPL-3.0-or-later](LICENSE)).
