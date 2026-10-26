/**
 * dsh-plugin-rea — the one-shot "run setup" guide.
 *
 * Why this exists: a market install or update replaces the package and stops
 * there. The runtime (Node, REA, a JDK, Ghidra) lives in the profile's
 * `plugins/rea-bundle` and is only moved by `scripts/setup.mjs`, which nobody
 * runs for the user. Skipping it fails twice, silently: on a first install the
 * MCP row exits MODULE_NOT_FOUND with no tools, and after an upgrade the old
 * REA keeps answering. The README says so; nobody reads the README.
 *
 * So the guide appears once per plugin version — first install, and again after
 * every upgrade — states which side is out of date, and shows the exact command
 * for THIS install (the path depends on where the market unpacked the package).
 * "Later" and "I ran it" both record the version and stop the reminder until
 * the next upgrade. It is a notice, not a runner: this file never spawns setup.
 *
 * Facts come from GET /dsh-plugin-rea/guide-state (index.mjs → bin/rea-guide.mjs),
 * which compares the recorded bundle against this package's pin. When that route
 * is absent (a host without a webServer, an older build) the guide stays silent
 * rather than guessing.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-rea",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useEffect, useState } = react;

    const name = "dsh-plugin-rea";
    const inject = ["slots"];
    const ROUTE = "/dsh-plugin-rea/guide-state";
    const ACK_KEY = "dsh-plugin-rea.guide.ack";

    const TEXT = {
      zh: {
        badge: "需要一次性配置",
        title: "还要跑一次 setup",
        leadMissing: "插件装好了，但运行时不在这个包里。",
        leadStale: "插件更新了，机器上的运行时还是旧的。",
        leadUnknown: "运行时记录不完整，无法确认它和本插件是否一致。",
        body: "setup.mjs 负责把 Node、REA、JDK、Ghidra 下载或对齐到本机。市场里的安装和更新只替换插件包，不会替你跑它。",
        statusMissing: "未检测到运行时 —— 这是一次全新的安装。",
        statusStale: "插件 {v}：运行时里是 REA {installed}，本插件钉 {pin}。",
        statusUnknown: "运行时记录里没有 REA 版本。",
        statusUnreadable: "运行时记录读不出来（bundle.json 无法解析）。",
        commandLabel: "在任意目录运行（路径已指向这次安装的插件）",
        copy: "复制命令",
        copied: "已复制",
        copyFailed: "复制失败，请手动选中",
        done: "我已运行",
        later: "稍后",
        hint: "跑完重启 dsh。这一步只对齐运行时，不会更新插件包本身；升级后同样再跑一次。",
        noteSmoke: "setup 结束时会用 JDK 自带的 java 跑一次真实分析来验证引擎 —— 那里 30–60 秒没有任何输出是正常的。",
        noteLock: "若它报 “another provisioning run holds …”，说明后台已有一个 setup 在跑，等它结束再试即可。",
        noteOverride: "若你开过 Ghidra 闸门覆盖（让本机跑 REA 未验证的 Ghidra），setup 会重新供给内置 REA，那层覆盖随之消失 —— 跑完执行 node scripts/ghidra-gate-override.mjs --enable --version 12.2 恢复。",
      },
      en: {
        badge: "ONE-TIME SETUP",
        title: "One more step: run setup",
        leadMissing: "The plugin is installed. Its runtime is not.",
        leadStale: "The plugin was updated; the runtime on this machine is still the old one.",
        leadUnknown: "The runtime record is incomplete, so it cannot be compared with this package.",
        body: "setup.mjs downloads or aligns Node, REA, a JDK and Ghidra on this machine. A market install or update only replaces the package — nothing runs it for you.",
        statusMissing: "No runtime found — this is a first install.",
        statusStale: "Plugin {v}: the runtime holds REA {installed}, this package pins {pin}.",
        statusUnknown: "The runtime record has no REA version.",
        statusUnreadable: "The runtime record cannot be read (bundle.json did not parse).",
        commandLabel: "Run it from any directory (the path points at this install)",
        copy: "Copy command",
        copied: "Copied",
        copyFailed: "Copy failed — select it manually",
        done: "I ran it",
        later: "Later",
        hint: "Restart dsh afterwards. This only aligns the runtime; it does not update the plugin package — run it again after the next upgrade.",
        noteSmoke: "It finishes by importing a small file to prove the analysis engine works — 30–60 s with no output there is normal.",
        noteLock: "If it reports “another provisioning run holds …”, a setup is already running in the background; wait for it.",
        noteOverride: "If you had enabled the Ghidra gate override (running a Ghidra REA has not verified), setup re-provisions the bundled REA and the patch goes with it — run node scripts/ghidra-gate-override.mjs --enable --version 12.2 afterwards to restore it.",
      },
    };

    function pickLang() {
      try {
        const declared = String((document.documentElement && document.documentElement.lang) || "");
        if (/^zh/i.test(declared)) return "zh";
        if (declared) return "en";
        const nav = String((typeof navigator !== "undefined" && navigator.language) || "");
        return /^zh/i.test(nav) ? "zh" : "en";
      } catch {
        return "en";
      }
    }

    function readAck() {
      try {
        return window.localStorage.getItem(ACK_KEY) || "";
      } catch {
        return "";
      }
    }

    function writeAck(version) {
      try {
        window.localStorage.setItem(ACK_KEY, String(version));
      } catch {
        /* private mode: the guide simply reappears next time */
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through to the selection path */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-9999px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    function statusLine(state, t) {
      if (state.state === "missing") return t.statusMissing;
      if (state.state === "stale") {
        return t.statusStale
          .replace("{v}", String(state.pluginVersion || "?"))
          .replace("{installed}", String(state.installedRea || "?"))
          .replace("{pin}", String(state.pinnedRea || "?"));
      }
      if (state.state === "unreadable") return t.statusUnreadable;
      return t.statusUnknown;
    }

    function leadLine(state, t) {
      if (state.state === "missing") return t.leadMissing;
      if (state.state === "stale") return t.leadStale;
      return t.leadUnknown;
    }

    const maskStyle = {
      position: "fixed",
      inset: 0,
      zIndex: 2400,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      background: "rgba(6, 8, 12, 0.55)",
      pointerEvents: "auto",
    };

    const cardStyle = {
      width: "min(620px, 100%)",
      maxHeight: "82vh",
      overflow: "auto",
      padding: "22px 24px 18px",
      borderRadius: 14,
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.14))",
      background: "var(--dsw-alias-bg-elevated, #171a20)",
      color: "var(--dsw-alias-label-primary, #e9e9e9)",
      boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
      lineHeight: 1.6,
      fontSize: 14,
    };

    const codeStyle = {
      margin: "10px 0 0",
      padding: "10px 12px",
      borderRadius: 9,
      background: "var(--dsw-alias-bg-secondary, rgba(255,255,255,0.06))",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.10))",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12.5,
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      userSelect: "all",
    };

    const buttonBase = {
      appearance: "none",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.18))",
      background: "transparent",
      color: "inherit",
      borderRadius: 8,
      padding: "6px 12px",
      fontSize: 13,
      cursor: "pointer",
      font: "inherit",
    };

    const primaryButton = Object.assign({}, buttonBase, {
      background: "var(--dsw-alias-label-brand, #4f8cff)",
      borderColor: "var(--dsw-alias-label-brand, #4f8cff)",
      color: "#fff",
      fontWeight: 600,
    });

    function Guide() {
      const [state, setState] = useState(null);
      const [closed, setClosed] = useState(false);
      const [copyLabel, setCopyLabel] = useState("");

      useEffect(() => {
        let alive = true;
        const ctrl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = setTimeout(() => {
          try {
            if (ctrl) ctrl.abort();
          } catch {
            /* ignore */
          }
        }, 5000);

        fetch(ROUTE, {
          signal: ctrl ? ctrl.signal : undefined,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        })
          .then((response) => (response && response.ok ? response.json() : null))
          .then((data) => {
            if (alive && data && typeof data === "object") setState(data);
          })
          .catch(() => {
            /* no route (headless host, older build): stay silent */
          })
          .finally(() => clearTimeout(timer));

        return () => {
          alive = false;
          clearTimeout(timer);
          try {
            if (ctrl) ctrl.abort();
          } catch {
            /* ignore */
          }
        };
      }, []);

      const lang = pickLang();
      const t = TEXT[lang];
      const acked = state ? readAck() === String(state.pluginVersion) : true;
      const visible = !!state && !closed && state.needsSetup === true && !acked;

      useEffect(() => {
        if (!visible) return undefined;
        const onKey = (event) => {
          if (event && (event.key === "Escape" || event.key === "Esc")) {
            writeAck(state.pluginVersion);
            setClosed(true);
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [visible, state]);

      if (!visible) return null;

      const dismiss = () => {
        writeAck(state.pluginVersion);
        setClosed(true);
      };

      const onCopy = () => {
        copyText(String(state.setupCommand || "")).then((ok) => {
          setCopyLabel(ok ? t.copied : t.copyFailed);
          setTimeout(() => setCopyLabel(""), 2500);
        });
      };

      const node = h(
        "div",
        { style: maskStyle, role: "dialog", "aria-modal": "true", "aria-label": t.title },
        h(
          "div",
          { style: cardStyle },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
            h(
              "span",
              {
                style: {
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--dsw-alias-bg-secondary, rgba(255,255,255,0.08))",
                  color: "var(--dsw-alias-label-secondary, #a9a9a9)",
                },
              },
              t.badge,
            ),
            h(
              "span",
              { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #a9a9a9)" } },
              `dsh-plugin-rea ${state.pluginVersion || ""}`,
            ),
          ),
          h("h2", { style: { margin: "0 0 6px", fontSize: 19, fontWeight: 700 } }, t.title),
          h(
            "p",
            { style: { margin: "0 0 4px", color: "var(--dsw-alias-label-secondary, #b6b6b6)" } },
            leadLine(state, t),
          ),
          h("p", { style: { margin: "0 0 10px" } }, t.body),

          h(
            "p",
            {
              style: {
                margin: "0 0 6px",
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--dsw-alias-bg-secondary, rgba(255,255,255,0.05))",
                color: "var(--dsw-alias-label-secondary, #c2c2c2)",
                fontSize: 13,
              },
            },
            statusLine(state, t),
          ),

          h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #9a9a9a)" } }, t.commandLabel),
          h("pre", { style: codeStyle }, h("code", null, String(state.setupCommand || ""))),

          h(
            "p",
            { style: { margin: "10px 0 8px", fontSize: 12.5, color: "var(--dsw-alias-label-secondary, #9a9a9a)" } },
            t.hint,
          ),
          h(
            "ul",
            {
              style: {
                margin: "0 0 16px",
                paddingLeft: 18,
                fontSize: 12.5,
                color: "var(--dsw-alias-label-secondary, #9a9a9a)",
              },
            },
            h("li", null, t.noteSmoke),
            h("li", null, t.noteLock),
            h("li", null, t.noteOverride),
          ),

          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
            h("button", { type: "button", style: primaryButton, onClick: onCopy }, copyLabel || t.copy),
            h("button", { type: "button", style: buttonBase, onClick: dismiss }, t.done),
            h("span", { style: { flex: 1 } }),
            h("button", { type: "button", style: buttonBase, onClick: dismiss }, t.later),
          ),
        ),
      );

      try {
        const dom = require("react-dom");
        if (dom && typeof dom.createPortal === "function" && typeof document !== "undefined" && document.body) {
          return dom.createPortal(node, document.body);
        }
      } catch {
        /* no react-dom: the overlay still renders in place */
      }
      return node;
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== "function") return;
      const mount = () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "rea-setup-guide", order: 70 },
          () => h(Guide),
        );
      if (typeof ctx.slots.inject === "function") ctx.slots.inject("shell.overlay", mount);
      else mount();
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
