#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Read-only dump of the LIO / targetcli configuration as JSON.

Invoked by the Cockpit front-end via cockpit.spawn() with superuser
privileges. Reads live kernel state through rtslib_fb (the same library
targetcli itself uses) so no screen-scraping is required.

This proof-of-concept is strictly read-only: it never modifies configfs.
"""

import json
import sys


def err(message):
    print(json.dumps({"error": message}))
    sys.exit(1)


try:
    from rtslib_fb import RTSRoot
except Exception as exc:  # pragma: no cover - environment dependent
    err("rtslib_fb is not available: %s" % exc)


def storage_object(so):
    return {
        "plugin": so.plugin,
        "name": so.name,
        "wwn": getattr(so, "wwn", None),
        "size": getattr(so, "size", None),
        "path": getattr(so, "udev_path", None),
        "status": getattr(so, "status", None),
    }


def node_acl(acl):
    return {
        "node_wwn": acl.node_wwn,
        "mapped_luns": [
            {
                "mapped_lun": m.mapped_lun,
                "tpg_lun": m.tpg_lun.lun,
                "write_protect": getattr(m, "write_protect", None),
            }
            for m in acl.mapped_luns
        ],
    }


def tpg(t):
    return {
        "tag": t.tag,
        "enable": bool(t.enable),
        "luns": [
            {
                "lun": lun.lun,
                "plugin": lun.storage_object.plugin,
                "storage_object": lun.storage_object.name,
            }
            for lun in t.luns
        ],
        "acls": [node_acl(a) for a in t.node_acls],
        "portals": [
            {"ip": p.ip_address, "port": p.port} for p in t.network_portals
        ],
    }


def target(t):
    return {
        "wwn": t.wwn,
        "fabric": t.fabric_module.name,
        "tpgs": [tpg(x) for x in t.tpgs],
    }


def main():
    try:
        root = RTSRoot()
        data = {
            "backstores": [storage_object(so) for so in root.storage_objects],
            "targets": [target(t) for t in root.targets],
        }
    except Exception as exc:
        err("failed to read LIO configuration: %s" % exc)
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
