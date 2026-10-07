// Fleet do e2e: implementa o contrato `FleetOps` do host_control com as peças
// REAIS — os stores (`daemons.json`/`workspaces.json`, via os módulos de
// `dist/`) e o spawn de verdade (`RpcChild` → `pi --mode rpc` + a extensão).
//
// Por que não subir o supervisor: ele é um serviço de longa duração com socket
// próprio. Reusar o `RpcChild`, que é exatamente o que o supervisor usa por
// baixo, dá a mesma prova (processo real, auth real no relay, superfície real)
// sem gerenciar um serviço.

import { existsSync } from "node:fs";

/**
 * @param {object} deps
 * @param {string} deps.extensionPath  caminho do `dist/index.js` do pi-extension
 * @param {new (opts: object) => any} deps.RpcChild  classe real do RpcChild
 * @param {object} deps.workspaces  módulo real `dist/daemon/workspaces.js`
 * @param {object} deps.registry  módulo real `dist/daemon/registry.js`
 * @param {object} deps.id  módulo real `dist/daemon/id.js`
 * @param {object} deps.localConfig  módulo real `dist/session/local_config.js`
 */
export function createFleet({ extensionPath, RpcChild, workspaces, registry, id, localConfig }) {
  /** id do daemon → RpcChild vivo */
  const children = new Map();

  /** Catálogo = adicionados ∪ registrados, com o daemon vencendo por cwd. */
  const entries = () => {
    const out = new Map();
    for (const w of workspaces.listWorkspaces()) {
      out.set(w.cwd, { cwd: w.cwd, name: w.name, source: "added" });
    }
    for (const d of registry.loadRegistry().daemons ?? []) {
      const name = d.name || localConfig.defaultAgentName(d.cwd);
      out.set(d.cwd, { cwd: d.cwd, name, source: "daemon" });
    }
    return [...out.values()];
  };

  const entryFor = (cwd, daemonId) => {
    const all = entries();
    if (daemonId) return all.find((e) => id.daemonIdForCwd(e.cwd) === daemonId);
    if (!cwd) return undefined;
    return all.find((e) => e.cwd === cwd || id.daemonIdForCwd(e.cwd) === id.daemonIdForCwd(cwd));
  };

  return {
    /** Exposto para o e2e asseverar a persistência real. */
    storedWorkspaces: () => workspaces.listWorkspaces(),
    daemonsPath: () => registry.registryPath(),
    workspacesPath: () => workspaces.workspacesPath(),

    list() {
      return entries().map((e) => ({
        id: id.daemonIdForCwd(e.cwd),
        cwd: e.cwd,
        name: e.name,
        live: children.has(id.daemonIdForCwd(e.cwd)),
        source: e.source,
      }));
    },

    ensure(cwd) {
      try {
        // Plan/68: workspace_start num cwd desconhecido REGISTRA em
        // workspaces.json (não em daemons.json — não vira daemon always-on).
        const { cwd: resolved, added } = workspaces.addWorkspace(cwd);
        const known = entryFor(resolved);
        void added;
        return {
          ok: true,
          id: id.daemonIdForCwd(resolved),
          cwd: resolved,
          name: known?.name ?? localConfig.defaultAgentName(resolved),
        };
      } catch (e) {
        const message = String(e?.message ?? e);
        // `normalizeCwd` lança quando o caminho não existe → erro tipado.
        return { ok: false, error: /ENOENT|no such file|not exist|realpath/i.test(message) ? "not_found" : message };
      }
    },

    /** Spawn real do daemon (`pi --mode rpc` + a extensão de dist/). */
    start(daemonId) {
      const entry = entries().find((e) => id.daemonIdForCwd(e.cwd) === daemonId);
      if (!entry) return { ok: false, error: "not_found" };
      if (children.has(daemonId)) return { ok: true, started: false };
      if (!existsSync(entry.cwd)) return { ok: false, error: "spawn_failed: cwd missing" };
      const child = new RpcChild({
        cwd: entry.cwd,
        extensionPath,
        config: { auto_start_relay: true, agent_name: entry.name },
      });
      children.set(daemonId, child);
      child.spawn();
      return { ok: true, started: true };
    },

    async stop(daemonId) {
      const child = children.get(daemonId);
      if (!child) return { ok: true, stopped: false };
      children.delete(daemonId);
      await child.stop();
      return { ok: true, stopped: true };
    },

    addWorkspace(cwd) {
      try {
        const { cwd: resolved, added } = workspaces.addWorkspace(cwd);
        return { ok: true, cwd: resolved, added };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },

    removeWorkspace(cwd) {
      const { cwd: resolved, removed } = workspaces.removeWorkspace(cwd);
      return { ok: true, cwd: resolved, removed };
    },

    /** Derruba tudo (teardown do e2e). */
    async shutdown() {
      const ids = [...children.keys()];
      for (const daemonId of ids) await this.stop(daemonId);
    },
  };
}
