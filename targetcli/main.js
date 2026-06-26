/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * iSCSI Targets — Cockpit module.
 *
 * Read path:  target-dump.py3   (strictly read-only)
 * Write path: target-action.py3 (additive-only, auto-backup, no deletes)
 *
 * Both helpers run via cockpit.spawn() with superuser. The front-end never
 * issues a destructive request; the only actions exposed are creates.
 */
"use strict";

const DUMP = "/usr/share/cockpit/targetcli/target-dump.py3";
const ACTION = "/usr/share/cockpit/targetcli/target-action.py3";

let STATE = { backstores: [], targets: [] };

const el = (id) => document.getElementById(id);

function setStatus(text) { el("status").textContent = text || ""; }

function showError(message) {
    const box = el("error");
    box.textContent = message;
    box.hidden = false;
}
function clearError() { el("error").hidden = true; }

function humanSize(bytes) {
    if (bytes === null || bytes === undefined) return "";
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/* ---------- read-only rendering ---------- */

function renderBackstores(backstores) {
    const card = node("section", "card");
    card.append(node("h2", null, `Backstores (${backstores.length})`));
    if (!backstores.length) {
        card.append(node("p", "empty", "No storage objects defined."));
        return card;
    }
    const table = node("table", "tbl");
    const head = node("tr");
    ["Plugin", "Name", "Size", "Path", "Status"].forEach((h) =>
        head.append(node("th", null, h)));
    table.append(head);
    backstores.forEach((b) => {
        const tr = node("tr");
        tr.append(node("td", "mono", b.plugin));
        tr.append(node("td", "mono", b.name));
        tr.append(node("td", null, humanSize(b.size)));
        tr.append(node("td", "mono path", b.path || ""));
        tr.append(node("td", null, b.status || ""));
        table.append(tr);
    });
    card.append(table);
    return card;
}

function renderTpg(tpg) {
    const wrap = node("div", "tpg");
    const header = node("div", "tpg-head");
    header.append(node("span", "badge", `TPG ${tpg.tag}`));
    header.append(node("span", tpg.enable ? "pill ok" : "pill off",
        tpg.enable ? "enabled" : "disabled"));
    wrap.append(header);

    const grid = node("div", "tpg-grid");

    const luns = node("div", "subcard");
    luns.append(node("h4", null, `LUNs (${tpg.luns.length})`));
    tpg.luns.forEach((l) =>
        luns.append(node("div", "row mono",
            `lun${l.lun} → ${l.plugin}/${l.storage_object}`)));
    grid.append(luns);

    const acls = node("div", "subcard");
    acls.append(node("h4", null, `ACLs / Initiators (${tpg.acls.length})`));
    tpg.acls.forEach((a) => {
        const r = node("div", "row mono", a.node_wwn);
        const mapped = a.mapped_luns
            .map((m) => `mapped_lun${m.mapped_lun}→lun${m.tpg_lun}`).join(", ");
        if (mapped) r.append(node("span", "muted", `  (${mapped})`));
        acls.append(r);
    });
    grid.append(acls);

    const portals = node("div", "subcard");
    portals.append(node("h4", null, `Portals (${tpg.portals.length})`));
    tpg.portals.forEach((p) =>
        portals.append(node("div", "row mono", `${p.ip}:${p.port}`)));
    grid.append(portals);

    wrap.append(grid);
    return wrap;
}

function renderTargets(targets) {
    const card = node("section", "card");
    card.append(node("h2", null, `Targets (${targets.length})`));
    if (!targets.length) {
        card.append(node("p", "empty", "No targets defined."));
        return card;
    }
    targets.forEach((t) => {
        const block = node("div", "target");
        const th = node("div", "target-head");
        th.append(node("span", "fabric", t.fabric));
        th.append(node("span", "iqn mono", t.wwn));
        block.append(th);
        t.tpgs.forEach((tpg) => block.append(renderTpg(tpg)));
        card.append(block);
    });
    return card;
}

/* ---------- write actions ---------- */

function field(labelText, input) {
    const wrap = node("label", "field");
    wrap.append(node("span", "flabel", labelText));
    wrap.append(input);
    return wrap;
}

function textInput(placeholder) {
    const i = document.createElement("input");
    i.type = "text";
    i.placeholder = placeholder || "";
    return i;
}

function targetTpgSelect() {
    const sel = document.createElement("select");
    STATE.targets.forEach((t) =>
        t.tpgs.forEach((tpg) => {
            const o = document.createElement("option");
            o.value = JSON.stringify({ target_wwn: t.wwn, tpg_tag: tpg.tag });
            o.textContent = `${t.wwn}  (tpg${tpg.tag})`;
            sel.append(o);
        }));
    return sel;
}

function backstoreSelect() {
    const sel = document.createElement("select");
    STATE.backstores.forEach((b) => {
        const o = document.createElement("option");
        o.value = JSON.stringify({ backstore_plugin: b.plugin, backstore_name: b.name });
        o.textContent = `${b.plugin}/${b.name}`;
        sel.append(o);
    });
    return sel;
}

function actionForm(title, hint, inputs, build, summarize) {
    const form = node("form", "subcard action-form");
    form.append(node("h4", null, title));
    if (hint) form.append(node("p", "muted hint", hint));
    inputs.forEach((f) => form.append(f));
    const btn = node("button", "btn", "Review & apply…");
    btn.type = "submit";
    form.append(btn);
    form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        let params;
        try { params = build(); } catch (e) { showError(e.message); return; }
        confirmAndRun(form.dataset.action, params, summarize(params));
    });
    return form;
}

function buildActions() {
    const card = node("section", "card");
    card.append(node("h2", null, "Add resources"));
    card.append(node("p", "muted",
        "All actions are additive and create a timestamped backup of " +
        "/etc/target/saveconfig.json before applying. Nothing existing is " +
        "modified or removed."));
    const grid = node("div", "tpg-grid");

    // create fileio backstore
    {
        const name = textInput("e.g. data01");
        const file = textInput("/ALLFLASH/ISCSI/data01.img");
        const size = textInput("e.g. 100G (blank = use existing file)");
        const f = actionForm("Create fileio backstore",
            "Backing file is created at the given size if it does not exist.",
            [field("Name", name), field("File path", file), field("Size", size)],
            () => {
                const p = { name: name.value.trim(), file: file.value.trim() };
                const b = parseSize(size.value.trim());
                if (b) p.size_bytes = b;
                if (!p.name || !p.file) throw new Error("Name and file path are required.");
                return p;
            },
            (p) => `Create fileio backstore "${p.name}" at ${p.file}` +
                (p.size_bytes ? ` (${humanSize(p.size_bytes)})` : " (existing file)"));
        f.dataset.action = "create-fileio";
        grid.append(f);
    }

    // create target
    {
        const wwn = textInput("blank = auto-generate IQN");
        const f = actionForm("Create iSCSI target",
            "Creates the target plus an enabled tpg1 (no-auth, explicit ACLs).",
            [field("Target IQN", wwn)],
            () => {
                const p = {};
                if (wwn.value.trim()) p.wwn = wwn.value.trim();
                return p;
            },
            (p) => `Create iSCSI target ${p.wwn || "(auto IQN)"} with enabled tpg1`);
        f.dataset.action = "create-target";
        grid.append(f);
    }

    // add portal
    {
        const tp = targetTpgSelect();
        const ip = textInput("0.0.0.0");
        const port = textInput("3260");
        const f = actionForm("Add portal",
            "Bind a target's tpg to an IP/port.",
            [field("Target / TPG", tp), field("IP", ip), field("Port", port)],
            () => {
                const sel = JSON.parse(tp.value || "{}");
                if (!sel.target_wwn) throw new Error("Select a target/TPG first.");
                if (!ip.value.trim()) throw new Error("IP is required.");
                return Object.assign(sel, { ip: ip.value.trim(),
                    port: parseInt(port.value.trim() || "3260", 10) });
            },
            (p) => `Add portal ${p.ip}:${p.port} to ${p.target_wwn} (tpg${p.tpg_tag})`);
        f.dataset.action = "add-portal";
        grid.append(f);
    }

    // add ACL
    {
        const tp = targetTpgSelect();
        const iqn = textInput("iqn.1998-01.com.vmware:host...");
        const f = actionForm("Add initiator ACL",
            "Allow an initiator IQN to access the tpg.",
            [field("Target / TPG", tp), field("Initiator IQN", iqn)],
            () => {
                const sel = JSON.parse(tp.value || "{}");
                if (!sel.target_wwn) throw new Error("Select a target/TPG first.");
                if (!iqn.value.trim()) throw new Error("Initiator IQN is required.");
                return Object.assign(sel, { node_wwn: iqn.value.trim() });
            },
            (p) => `Add ACL for ${p.node_wwn} on ${p.target_wwn} (tpg${p.tpg_tag})`);
        f.dataset.action = "add-acl";
        grid.append(f);
    }

    // add LUN
    {
        const tp = targetTpgSelect();
        const bs = backstoreSelect();
        const f = actionForm("Map LUN",
            "Expose a backstore as a LUN on the tpg.",
            [field("Target / TPG", tp), field("Backstore", bs)],
            () => {
                const sel = JSON.parse(tp.value || "{}");
                const b = JSON.parse(bs.value || "{}");
                if (!sel.target_wwn) throw new Error("Select a target/TPG first.");
                if (!b.backstore_name) throw new Error("Select a backstore first.");
                return Object.assign(sel, b);
            },
            (p) => `Map ${p.backstore_plugin}/${p.backstore_name} as a LUN on ` +
                `${p.target_wwn} (tpg${p.tpg_tag})`);
        f.dataset.action = "add-lun";
        grid.append(f);
    }

    card.append(grid);
    return card;
}

function parseSize(s) {
    if (!s) return null;
    const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)i?B?$/i.exec(s.trim());
    if (!m) throw new Error(`Unrecognized size: "${s}"`);
    const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3,
                   T: 1024 ** 4, P: 1024 ** 5 }[m[2].toUpperCase()];
    return Math.round(parseFloat(m[1]) * mult);
}

/* ---------- confirm dialog + run ---------- */

function confirmAndRun(action, params, summary) {
    clearError();
    const overlay = node("div", "overlay");
    const dialog = node("div", "dialog");
    dialog.append(node("h3", null, "Confirm change"));
    dialog.append(node("p", null, summary));
    dialog.append(node("p", "muted",
        "A backup of the current config will be written to " +
        "/etc/target/backups/ before this change is applied and persisted."));
    const bar = node("div", "dialog-bar");
    const cancel = node("button", "btn ghost", "Cancel");
    const apply = node("button", "btn", "Apply");
    cancel.type = "button"; apply.type = "button";
    bar.append(cancel); bar.append(apply);
    dialog.append(bar);
    overlay.append(dialog);
    document.body.append(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    apply.addEventListener("click", () => {
        apply.disabled = true; cancel.disabled = true;
        apply.textContent = "Applying…";
        runAction(action, params)
            .then((res) => {
                close();
                setStatus(res.message);
                load();   // refresh tree
            })
            .catch((msg) => {
                close();
                showError(msg);
            });
    });
}

function runAction(action, params) {
    return new Promise((resolve, reject) => {
        const proc = cockpit.spawn(["python3", ACTION, action],
            { superuser: "require", err: "message" });
        proc.input(JSON.stringify(params));
        proc.then((output) => {
            let res;
            try { res = JSON.parse(output); }
            catch (e) { reject("Could not parse helper output: " + output); return; }
            if (res.ok) resolve(res);
            else reject(res.message || "Action failed");
        }).catch((ex) => {
            // Helper exits non-zero on failure; surface its JSON message.
            const out = (ex && ex.message) || String(ex);
            try { reject(JSON.parse(out).message); }
            catch (e) { reject("Helper error: " + out); }
        });
    });
}

/* ---------- load ---------- */

function render(data) {
    STATE = data;
    const content = el("content");
    content.textContent = "";
    content.append(renderBackstores(data.backstores || []));
    content.append(renderTargets(data.targets || []));
    content.append(buildActions());
}

function load() {
    clearError();
    setStatus("Loading…");
    cockpit.spawn(["python3", DUMP], { superuser: "require", err: "message" })
        .then((output) => {
            let data;
            try { data = JSON.parse(output); }
            catch (e) { showError("Could not parse helper output: " + e); setStatus(""); return; }
            if (data.error) { showError(data.error); setStatus(""); return; }
            render(data);
            setStatus("Updated " + new Date().toLocaleTimeString());
        })
        .catch((ex) => {
            showError("Failed to run helper: " + (ex.message || ex));
            setStatus("");
        });
}

document.addEventListener("DOMContentLoaded", () => {
    el("refresh").addEventListener("click", load);
    load();
});
