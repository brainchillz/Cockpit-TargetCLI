#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Additive write operations for the LIO / targetcli Cockpit module.

Invoked by the Cockpit front-end via cockpit.spawn() with superuser.
Reads a JSON parameter object from stdin and an action name from argv[1].

SAFETY MODEL (deliberate, do not loosen without review):
  * Only ADDITIVE operations are implemented. There is no delete/clear/
    remove/modify path anywhere in this file.
  * Every mutating action first snapshots /etc/target/saveconfig.json to a
    timestamped backup under /etc/target/backups/ so the prior state can be
    restored manually if needed.
  * Each create uses rtslib mode='create', which raises if the object
    already exists -- so an existing backstore/target/LUN/ACL/portal can
    never be clobbered or silently reused.
  * After a successful change the running config is persisted with
    save_to_file() so it survives reboot.

Output: a single JSON object on stdout: {"ok": bool, "message": str, ...}.
"""

import json
import os
import shutil
import sys
import time

SAVE_FILE = "/etc/target/saveconfig.json"
BACKUP_DIR = "/etc/target/backups"


def respond(ok, message, **extra):
    out = {"ok": bool(ok), "message": message}
    out.update(extra)
    print(json.dumps(out))
    sys.exit(0 if ok else 1)


def fail(message):
    respond(False, message)


try:
    from rtslib_fb import (
        RTSRoot, FabricModule, Target, TPG, NetworkPortal,
        NodeACL, LUN, FileIOStorageObject, BlockStorageObject,
    )
except Exception as exc:  # pragma: no cover
    fail("rtslib_fb is not available: %s" % exc)


def backup():
    """Snapshot the persisted config before mutating. Returns backup path."""
    if not os.path.exists(SAVE_FILE):
        return None
    os.makedirs(BACKUP_DIR, mode=0o700, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUP_DIR, "saveconfig-%s.json" % stamp)
    shutil.copy2(SAVE_FILE, dest)
    return dest


def persist():
    RTSRoot().save_to_file(SAVE_FILE)


def find_tpg(root, target_wwn, tpg_tag):
    for t in root.targets:
        if t.wwn == target_wwn:
            for tpg in t.tpgs:
                if int(tpg.tag) == int(tpg_tag):
                    return tpg
            fail("TPG %s not found on target %s" % (tpg_tag, target_wwn))
    fail("target %s not found" % target_wwn)


def find_storage_object(root, plugin, name):
    for so in root.storage_objects:
        if so.plugin == plugin and so.name == name:
            return so
    fail("backstore %s/%s not found" % (plugin, name))


# ---- actions -------------------------------------------------------------

def act_create_fileio(p):
    name = (p.get("name") or "").strip()
    path = (p.get("file") or "").strip()
    if not name or not path:
        fail("name and file are required")
    backup()
    if os.path.exists(path):
        # Existing file: size is derived from it, must not be passed.
        so = FileIOStorageObject(name, dev=path, write_back=bool(p.get("write_back", True)))
        detail = "using existing file"
    else:
        size = p.get("size_bytes")
        if not size:
            fail("size_bytes is required when the backing file does not exist")
        so = FileIOStorageObject(name, dev=path, size=int(size),
                                 write_back=bool(p.get("write_back", True)))
        detail = "created new %d-byte file" % int(size)
    persist()
    respond(True, "Created fileio backstore '%s' (%s)" % (name, detail),
            wwn=so.wwn)


def act_create_target(p):
    wwn = (p.get("wwn") or "").strip() or None
    backup()
    fabric = FabricModule("iscsi")
    target = Target(fabric, wwn=wwn, mode="create")
    tpg = TPG(target, tag=1, mode="create")
    tpg.enable = True
    # Default to explicit ACLs (no demo mode) and no auth, matching the
    # common targetcli default the existing target already uses.
    try:
        tpg.set_attribute("authentication", "0")
        tpg.set_attribute("generate_node_acls", "0")
    except Exception:
        pass
    persist()
    respond(True, "Created iSCSI target '%s' with enabled tpg1" % target.wwn,
            wwn=target.wwn)


def act_add_portal(p):
    root = RTSRoot()
    tpg = find_tpg(root, p.get("target_wwn"), p.get("tpg_tag", 1))
    ip = (p.get("ip") or "").strip()
    port = int(p.get("port") or 3260)
    if not ip:
        fail("ip is required")
    backup()
    NetworkPortal(tpg, ip, port, mode="create")
    persist()
    respond(True, "Added portal %s:%d" % (ip, port))


def act_add_acl(p):
    root = RTSRoot()
    tpg = find_tpg(root, p.get("target_wwn"), p.get("tpg_tag", 1))
    node_wwn = (p.get("node_wwn") or "").strip()
    if not node_wwn:
        fail("node_wwn (initiator IQN) is required")
    backup()
    NodeACL(tpg, node_wwn, mode="create")
    persist()
    respond(True, "Added ACL for initiator '%s'" % node_wwn)


def act_add_lun(p):
    root = RTSRoot()
    tpg = find_tpg(root, p.get("target_wwn"), p.get("tpg_tag", 1))
    so = find_storage_object(root, p.get("backstore_plugin"),
                             p.get("backstore_name"))
    backup()
    lun = LUN(tpg, storage_object=so)
    persist()
    respond(True, "Mapped %s/%s as lun%s" %
            (so.plugin, so.name, lun.lun), lun=lun.lun)


def act_backup(p):
    dest = backup()
    if dest:
        respond(True, "Saved backup", path=dest)
    respond(True, "No existing config to back up", path=None)


ACTIONS = {
    "backup": act_backup,
    "create-fileio": act_create_fileio,
    "create-target": act_create_target,
    "add-portal": act_add_portal,
    "add-acl": act_add_acl,
    "add-lun": act_add_lun,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ACTIONS:
        fail("unknown action; expected one of: %s" % ", ".join(sorted(ACTIONS)))
    raw = sys.stdin.read()
    try:
        params = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        fail("invalid JSON parameters: %s" % exc)
    try:
        ACTIONS[sys.argv[1]](params)
    except Exception as exc:
        fail("%s: %s" % (type(exc).__name__, exc))


if __name__ == "__main__":
    main()
