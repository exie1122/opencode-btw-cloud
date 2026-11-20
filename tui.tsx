/** @jsxImportSource @opentui/solid */
// opencode-btw-cloud: like the built-in /btw, but answered by a model you choose
// (typically a fast cloud model while your main session runs on a local LLM).
//
// How a question is answered:
//   1. fork the current session (copies the full native history, ~instant)
//   2. switch the fork to the chosen model
//   3. session.generate on the fork (the same one-shot, tool-free call /btw uses),
//      noting which model(s) wrote the history unless turned off in /btw-cloud-settings
//   4. show the answer in a popup (with optional stats); "f" asks a follow-up on the same fork
//   5. delete the fork when the popup closes
//      (or press "o" to keep it, with the side thread added, and open it)
// The main session, its model and its local KV cache are never touched.
import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, on, Show, type Accessor } from "solid-js"

type ModelRef = { providerID: string; id: string }

const ID = "btw-cloud"

// Same instruction the built-in /btw uses.
const PREAMBLE = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

// Without this note, the side model reads the session's earlier assistant
// messages as its own replies (the chat format has no "written by another
// model" marker) and answers as if it had done that work itself.
const attributionNote = (authors: string[], side: ModelRef) =>
  [
    `Note: the earlier assistant messages in this conversation were not written by you.`,
    `They were written by the main session's assistant (${authors.join(", ")}).`,
    authors.includes(label(side)) ? "Where that is the same model as you, it was a separate run; you did not write them." : "",
    `You are ${label(side)}, a separate model brought in only to answer this side question.`,
    `Refer to that work as the main assistant's, not as your own, and when asked to review or critique it, do so as an outside reviewer.`,
  ]
    .filter(Boolean)
    .join(" ")

const unwrap = <T,>(r: any): T => (r && typeof r === "object" && "data" in r && Object.keys(r).length <= 2 ? r.data : r)

const parseModel = (s: unknown): ModelRef | undefined => {
  if (typeof s !== "string") return
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return
  return { providerID: s.slice(0, i), id: s.slice(i + 1) }
}

const label = (m: ModelRef) => `${m.providerID}/${m.id}`

// Measured for each answer; which of them are shown is set in /btw-cloud-settings.
type Stats = { seconds: number; output: number; context: number; limit?: number; cost?: number }
type Turn = { q: string; a?: string; error?: string; stats?: Stats }

type StatKey = "time" | "speed" | "context" | "cost"
type Settings = { attribution: boolean; stats: Record<StatKey, boolean> }
const STATS: { key: StatKey; title: string }[] = [
  { key: "time", title: "Response time" },
  { key: "speed", title: "Tokens per second" },
  { key: "context", title: "Context used" },
  { key: "cost", title: "Cost" },
]

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))

// "3.2s · 85.1 tok/s · 9.1K (5%) · $0.0012", like OpenCode's line under each reply.
const statsLine = (s: Stats | undefined, show: Record<StatKey, boolean>) => {
  if (!s) return ""
  const parts: string[] = []
  if (show.time) parts.push(`${s.seconds.toFixed(1)}s`)
  if (show.speed && s.output > 0 && s.seconds > 0) parts.push(`${(s.output / s.seconds).toFixed(1)} tok/s`)
  if (show.context && s.context > 0)
    parts.push(s.limit ? `${fmtTokens(s.context)} (${Math.round((s.context / s.limit) * 100)}%)` : fmtTokens(s.context))
  if (show.cost && s.cost !== undefined) parts.push(s.cost > 0 && s.cost < 0.01 ? `$${s.cost.toFixed(4)}` : `$${s.cost.toFixed(2)}`)
  return parts.join(" · ")
}

// Markdown/code styling built from the active theme, mirroring the mapping
// OpenCode uses for its own markdown (headings, emphasis, code, links, syntax).
function makeSyntaxStyle(context: any): SyntaxStyle {
  const t = context.theme ?? {}
  const sx = t.syntax ?? {}
  const md = t.markdown ?? {}
  const rule = (scope: string[], foreground: any, extra: Record<string, unknown> = {}) =>
    foreground ? [{ scope, style: { foreground, ...extra } }] : []
  const rules = [
    ...rule(["default"], md.text ?? t.text?.base),
    ...rule(["comment", "comment.documentation"], sx.comment, { italic: true }),
    ...rule(["string", "symbol", "character", "character.special"], sx.string),
    ...rule(["number", "boolean", "constant", "float"], sx.number),
    ...rule(["keyword.type"], sx.type, { bold: true, italic: true }),
    ...rule(["keyword.function", "function.method"], sx.function),
    ...rule(["keyword", "keyword.return", "keyword.conditional", "keyword.repeat", "keyword.modifier"], sx.keyword, { italic: true }),
    ...rule(["keyword.import", "keyword.export", "string.escape", "string.regexp", "tag.attribute"], sx.keyword),
    ...rule(["operator", "keyword.operator", "punctuation.delimiter"], sx.operator),
    ...rule(["variable", "variable.parameter", "function.call", "function.method.call", "property", "parameter", "field"], sx.variable),
    ...rule(["variable.member", "function", "constructor"], sx.function),
    ...rule(["type", "module", "class", "namespace"], sx.type),
    ...rule(["type.definition"], sx.type, { bold: true }),
    ...rule(["punctuation", "punctuation.bracket"], sx.punctuation),
    ...rule(["punctuation.special", "tag.delimiter"], sx.operator),
    ...rule(["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], md.heading, { bold: true }),
    ...rule(["markup.heading.1"], md.heading, { bold: true, underline: true }),
    ...rule(["markup.bold", "markup.strong"], md.strong, { bold: true }),
    ...rule(["markup.italic"], md.emphasis, { italic: true }),
    ...rule(["markup.list"], md.listItem),
    ...rule(["markup.quote"], md.blockQuote, { italic: true }),
    ...rule(["markup.raw", "markup.raw.block", "markup.raw.inline"], md.code),
    ...rule(["markup.link", "markup.link.url", "string.special", "string.special.url"], md.link, { underline: true }),
    ...rule(["markup.link.label", "label"], md.linkText, { underline: true }),
    ...rule(["markup.strikethrough", "markup.list.unchecked"], t.text?.muted),
  ]
  try {
    return (SyntaxStyle as any).fromTheme(rules, context.renderer.nativeScene)
  } catch {
    return SyntaxStyle.fromStyles({ default: { fg: t.text?.base } }, context.renderer.nativeScene)
  }
}

export default Plugin.define({
  id: ID,
  setup(context: any) {
    const theme = () => context.theme
    const [pending, setPending] = createSignal(0)

    // Persisted choice from /btw-cloud-model; falls back to the plugin's `model` option.
    // `attribution` (default on): tell the side model that the main session's model wrote the history.
    // `stats` (each default on): which numbers to show under each answer.
    const [saved, setSaved] = context.storage.store("settings", {
      initial: { model: null as string | null, attribution: null as boolean | null, stats: {} as Partial<Record<StatKey, boolean>> },
    })
    const read = () => (typeof saved === "function" ? saved() : saved)
    const currentModel = (): ModelRef | undefined => parseModel(read()?.model) ?? parseModel(context.options?.model)
    const settings = (): Settings => {
      const s = read() ?? {}
      const opt = context.options ?? {}
      return {
        attribution: s.attribution ?? opt.attribution ?? true,
        stats: Object.fromEntries(STATS.map(({ key }) => [key, s.stats?.[key] ?? opt.stats?.[key] ?? true])) as Record<StatKey, boolean>,
      }
    }
    const saveSettings = (next: Settings) =>
      setSaved((s: any) => {
        s.attribution = next.attribution
        s.stats = { ...next.stats }
      })

    // Models that wrote the session's assistant messages, in order of first appearance.
    const historyAuthors = async (sessionID: string): Promise<string[]> => {
      const collect = () => {
        const seen = new Set<string>()
        for (const m of (context.data.session.message.list(sessionID) ?? []) as any[]) {
          if (m?.type === "assistant" && m.model?.providerID && m.model?.id) seen.add(label(m.model))
        }
        return [...seen]
      }
      try {
        let authors = collect()
        if (authors.length === 0) {
          await context.data.session.message.sync(sessionID)
          authors = collect()
        }
        if (authors.length > 0) return authors
        const m = context.data.session.get(sessionID)?.model
        return m?.providerID && m?.id ? [label(m)] : []
      } catch {
        return []
      }
    }

    const toast = (message: string, variant = "info") => context.ui.toast.show({ title: "/btw-cloud", message, variant })

    // "/btw-cloud" chip in the prompt footer while a question is running.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={pending() > 0}>
          <box flexShrink={0}>
            <text fg={theme()?.hue?.interactive?.[200] ?? theme()?.text?.base}>/btw-cloud</text>
          </box>
        </Show>
      ),
    })

    const pickModel = async (): Promise<ModelRef | undefined> => {
      let models: any[] = []
      try {
        models = unwrap<any[]>(await context.client.model.list()) ?? []
      } catch (err: any) {
        toast(`Could not list models: ${err?.message ?? err}`, "error")
        return
      }
      const options = models
        .filter((m) => (m.type ?? "chat") === "chat" && m.capabilities?.output?.includes?.("text") !== false)
        .map((m) => ({
          title: m.name ?? m.id,
          value: `${m.providerID}/${m.id}`,
          description: `${m.providerID}/${m.id}`,
          category: m.providerID,
        }))
        .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      if (options.length === 0) {
        toast("No models available. Connect a provider first.", "warning")
        return
      }
      const cur = currentModel()
      const choice = await context.ui.dialog.select({
        title: "/btw-cloud model",
        placeholder: "Search models",
        options,
        current: cur ? label(cur) : undefined,
      })
      const ref = parseModel(choice)
      if (!ref) return
      await setSaved((s: any) => {
        s.model = label(ref)
      })
      toast(`Side questions will use ${label(ref)}`, "success")
      return ref
    }

    // Forks that are in flight are recorded on disk so that, if OpenCode exits
    // mid-question, they get cleaned up on the next start instead of leaking.
    const [inflight, setInflight] = context.storage.store("inflight", { initial: { ids: [] as string[] } })
    const readInflight = (): string[] => (typeof inflight === "function" ? inflight() : inflight)?.ids ?? []
    const track = (id: string) => setInflight((s: any) => void (s.ids = [...(s.ids ?? []).filter((x: string) => x !== id), id]))
    const untrack = (id: string) => setInflight((s: any) => void (s.ids = (s.ids ?? []).filter((x: string) => x !== id)))
    const removeFork = async (id: string) => {
      await context.client.session.remove({ sessionID: id }).catch((err: any) => {
        // Already gone counts as removed; anything else stays tracked for the next start.
        if (!/not.?found|404/i.test(String(err?.message ?? err))) throw err
      })
      await untrack(id)
    }
    for (const id of readInflight()) removeFork(id).catch(() => {})

    // Fork the session onto `model`. The fork is tracked until removed.
    const forkOnto = async (sessionID: string, model: ModelRef): Promise<string> => {
      const fork = unwrap<any>(await context.client.session.fork({ sessionID }))
      const id = fork?.id
      if (!id) throw new Error("Could not fork the session")
      await track(id)
      try {
        await context.client.session.switchModel({ sessionID: id, model })
      } catch (err) {
        await removeFork(id).catch(() => {})
        throw err
      }
      return id
    }

    // One side conversation: a fork that lives while the popup is open.
    const ask = async (sessionID: string, question: string, model: ModelRef) => {
      setPending((n) => n + 1)
      const [turns, setTurns] = createSignal<Turn[]>([{ q: question }])
      const [busy, setBusy] = createSignal(true)
      let forkID: string | undefined
      let closed = false
      let kept = false
      let note = ""
      // the side model's context window, for the "context used" percentage
      const contextLimit: Promise<number | undefined> = context.client.model
        .list()
        .then((r: any) => unwrap<any[]>(r)?.find((m: any) => m.providerID === model.providerID && m.id === model.id)?.limit?.context)
        .catch(() => undefined)

      const answer = async (q: string, history: Turn[]) => {
        const prompt =
          history.length === 0
            ? [PREAMBLE, note, q].filter(Boolean).join("\n\n")
            : [
                PREAMBLE,
                note,
                "This is a follow-up in an ongoing side conversation. Earlier side questions and your answers:",
                history.map((t) => `Q: ${t.q}\n\nA: ${t.a ?? t.error ?? ""}`).join("\n\n---\n\n"),
                `Follow-up question: ${q}`,
              ]
                .filter(Boolean)
                .join("\n\n")
        const started = performance.now()
        const res = unwrap<any>(await context.client.session.generate({ sessionID: forkID, prompt }))
        const seconds = (performance.now() - started) / 1000
        const tk = res?.tokens ?? {}
        const output = (tk.output ?? 0) + (tk.reasoning ?? 0)
        const stats: Stats = {
          seconds,
          output,
          // counted the way OpenCode's context meter does: everything in the request plus the reply
          context: (tk.input ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0) + output,
          limit: await contextLimit,
          cost: typeof res?.cost === "number" ? res.cost : undefined,
        }
        return { a: String(res?.text ?? "").trim() || "_(empty response)_", stats }
      }

      const setLast = (patch: Partial<Turn>) =>
        setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...patch } : t)))

      const followUp = async (q: string) => {
        if (busy() || closed || !forkID) return
        const history = turns().filter((t) => t.a !== undefined)
        setTurns((ts) => [...ts, { q }])
        setBusy(true)
        setPending((n) => n + 1)
        try {
          const r = await answer(q, history)
          if (!closed) setLast(r)
        } catch (err: any) {
          if (!closed) setLast({ error: String(err?.message ?? err) })
        } finally {
          setBusy(false)
          setPending((n) => n - 1)
        }
      }

      // "o": keep the fork, record the side thread in it, and open it.
      const keep = async () => {
        if (!forkID || busy()) return
        kept = true
        const id = forkID
        context.ui.dialog.clear()
        try {
          const thread = turns()
            .filter((t) => t.a !== undefined)
            .map((t) => `**Q:** ${t.q}\n\n**A:** ${t.a}`)
            .join("\n\n---\n\n")
          await context.client.session
            .synthetic({
              sessionID: id,
              text: `Side conversation from /btw-cloud (answered by ${label(model)}), for context:\n\n${thread}`,
              description: "/btw-cloud side thread",
              resume: false,
            })
            .catch(() => {})
          await untrack(id) // a real session now
          context.ui.router.navigate({ type: "session", sessionID: id })
        } catch (err: any) {
          toast(String(err?.message ?? err), "error")
        }
      }

      try {
        if (settings().attribution) {
          const authors = await historyAuthors(sessionID)
          if (authors.length > 0) note = attributionNote(authors, model)
        }
        forkID = await forkOnto(sessionID, model)
        setLast(await answer(question, []))
      } catch (err: any) {
        if (forkID) await removeFork(forkID).catch(() => {})
        toast(String(err?.message ?? err), "error")
        return
      } finally {
        setBusy(false)
        setPending((n) => n - 1)
      }

      const style = makeSyntaxStyle(context)
      context.ui.dialog.show(
        () => (
          <AnswerView
            context={context}
            model={model}
            turns={turns}
            show={() => settings().stats}
            busy={busy}
            style={style}
            onFollowUp={followUp}
            onKeep={keep}
          />
        ),
        () => {
          closed = true
          if (!kept && forkID) removeFork(forkID).catch(() => {})
          context.renderer.idle?.().then(() => style.destroy())
        },
      )
      context.ui.dialog.set({ size: "large", centered: true })
    }

    // /btw-cloud-settings. Toggles are edited on a draft; enter saves it, esc discards it.
    // Choosing "Model" opens the model picker, then comes back here with the draft intact.
    const openSettings = (draft: Settings = settings(), selected = 0) => {
      context.ui.dialog.show(() => (
        <SettingsView
          context={context}
          draft={draft}
          selected={selected}
          model={() => currentModel()}
          onSave={async (next) => {
            context.ui.dialog.clear()
            await saveSettings(next)
            toast("Settings saved", "success")
          }}
          onPickModel={async (next, at) => {
            context.ui.dialog.clear()
            await pickModel()
            openSettings(next, at)
          }}
        />
      ))
      context.ui.dialog.set({ size: "medium", centered: true })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${ID}.ask`,
          title: "Ask a side question (btw-cloud)",
          description: "One-shot answer from the session's context using your chosen model, without adding to the conversation",
          group: "Session",
          palette: true,
          slash: { name: "btw-cloud", arguments: true },
          async run(input?: string) {
            const route = context.ui.router.current()
            if (route?.type !== "session") return toast("Open a session first", "warning")
            const model = currentModel() ?? (await pickModel())
            if (!model) return
            const question =
              input?.trim() || (await context.ui.dialog.prompt({ title: "/btw-cloud", placeholder: "Ask anything" }))
            if (!question) return
            void ask(route.sessionID, question, model)
          },
        },
        {
          id: `${ID}.model`,
          title: "Choose /btw-cloud model",
          description: "Pick which model answers /btw-cloud side questions",
          group: "Session",
          palette: true,
          slash: { name: "btw-cloud-model" },
          async run() {
            await pickModel()
          },
        },
        {
          id: `${ID}.settings`,
          title: "/btw-cloud settings",
          description: "Model, history attribution and answer stats for /btw-cloud side questions",
          group: "Session",
          palette: true,
          slash: { name: "btw-cloud-settings" },
          run() {
            openSettings()
          },
        },
      ],
    }))
  },
})

// The same vertical scrollbar OpenCode puts on its chat: wheel, arrow keys, or drag the thumb.
const scrollbar = (t: any, track: any) => ({
  visible: true,
  paddingLeft: 1,
  trackOptions: { backgroundColor: track, foregroundColor: t?.scrollbar?.base ?? t?.border?.base ?? t?.text?.muted },
})

function KeyHint(p: { label: string; keys: string; fg: any; muted: any }) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={p.fg}>{p.label}</text>
      <text fg={p.muted}>{p.keys}</text>
    </box>
  )
}

function AnswerView(props: {
  context: any
  model: ModelRef
  turns: Accessor<Turn[]>
  show: () => Record<StatKey, boolean>
  busy: Accessor<boolean>
  style: SyntaxStyle
  onFollowUp: (q: string) => void
  onKeep: () => void
}) {
  const t = props.context.theme.surface?.("dialog") ?? props.context.theme
  const raised = t?.background?.raised?.high
  const muted = t?.text?.muted
  const base = t?.text?.base
  const dims = useTerminalDimensions()
  const [copied, setCopied] = createSignal(false)
  const [typing, setTyping] = createSignal(false)
  let draft = ""
  let box: any

  const lastAnswer = () => [...props.turns()].reverse().find((x) => x.a !== undefined)?.a ?? ""
  const toBottom = () => setTimeout(() => box?.scrollTo?.(box.scrollHeight), 0)
  // keep the newest follow-up (and its answer, once it lands) in view
  createEffect(
    on(
      () => [props.turns().length, props.turns().at(-1)?.a, props.turns().at(-1)?.error],
      () => props.turns().length > 1 && toBottom(),
      { defer: true },
    ),
  )

  const copy = () => {
    try {
      const ok = props.context.renderer.copyToClipboardOSC52?.(lastAnswer())
      if (ok === false || ok === undefined) throw new Error("unsupported")
      setCopied(true)
    } catch {
      props.context.ui.toast.show({ message: "Clipboard copy is not supported in this terminal", variant: "warning" })
    }
  }

  const submit = (value?: string) => {
    const q = (value ?? draft).trim()
    draft = ""
    setTyping(false)
    if (!q) return
    setCopied(false)
    props.onFollowUp(q)
    toBottom()
  }

  useKeyboard((key: any) => {
    if (typing()) return // the input owns the keyboard while typing
    if (key.name === "c") return copy()
    if (key.name === "o") return props.onKeep()
    if (key.name === "f" && !props.busy()) {
      draft = ""
      // open the input after this keypress is done, so the "f" isn't typed into it
      return void setTimeout(() => setTyping(true), 0)
    }
    if (!box) return
    const page = Math.max(8, Math.floor(dims().height * 0.6))
    if (key.name === "up" || key.name === "k") return box.scrollBy(-1)
    if (key.name === "down" || key.name === "j") return box.scrollBy(1)
    if (key.name === "pageup") return box.scrollBy(-page)
    if (key.name === "pagedown") return box.scrollBy(page)
    if (key.name === "home") return box.scrollTo(0)
    if (key.name === "end") return box.scrollTo(box.scrollHeight)
  })

  const Hint = (p: { label: string; keys: string }) => <KeyHint label={p.label} keys={p.keys} fg={base} muted={muted} />

  return (
    <box flexDirection="column">
      {/* header */}
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={base} attributes={1} flexShrink={0}>
          /btw-cloud
        </text>
        <text fg={muted} wrapMode="none" truncate flexGrow={1}>
          {props.turns()[0]?.q.replace(/\s+/g, " ")}
        </text>
        <text fg={muted} flexShrink={0}>
          {props.model.id}
        </text>
        <text fg={muted} flexShrink={0}>
          esc
        </text>
      </box>

      {/* thread */}
      <scrollbox
        ref={(el: any) => (box = el)}
        maxHeight={Math.max(8, Math.floor(dims().height * 0.6))}
        contentOptions={{ minHeight: 0 }}
        verticalScrollbarOptions={scrollbar(t, raised)}
        backgroundColor={raised}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1}>
          <For each={props.turns()}>
            {(turn, i) => (
              <box flexDirection="column" gap={1}>
                <Show when={i() > 0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={t?.markdown?.heading ?? base} attributes={1} flexShrink={0}>
                      ›
                    </text>
                    <text fg={base} attributes={1}>
                      {turn.q}
                    </text>
                  </box>
                </Show>
                <Show
                  when={turn.a !== undefined}
                  fallback={
                    <text fg={turn.error ? (t?.syntax?.variable ?? base) : muted}>
                      {turn.error ? `Error: ${turn.error}` : "Thinking…"}
                    </text>
                  }
                >
                  <markdown
                    content={turn.a}
                    syntaxStyle={props.style}
                    conceal
                    internalBlockMode="top-level"
                    tableOptions={{ style: "grid", cellPaddingX: 1 }}
                    fg={t?.markdown?.text ?? base}
                    bg={raised}
                  />
                  <Show when={statsLine(turn.stats, props.show())}>
                    {(line) => <text fg={muted}>{line()}</text>}
                  </Show>
                </Show>
              </box>
            )}
          </For>
        </box>
      </scrollbox>

      {/* footer: hints, or the follow-up input */}
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <Show
          when={typing()}
          fallback={
            <>
              <Hint label={copied() ? "✓ copied" : "copy"} keys="c" />
              <Show when={!props.busy()} fallback={<Hint label="answering" keys="…" />}>
                <Hint label="follow-up" keys="f" />
              </Show>
              <Hint label="open as session" keys="o" />
              <Hint label="scroll" keys="j/k ↑/↓ drag" />
            </>
          }
        >
          <text fg={t?.markdown?.heading ?? base} attributes={1} flexShrink={0}>
            ›
          </text>
          <input
            flexGrow={1}
            focused
            placeholder="Ask a follow-up… (enter to send)"
            onInput={(v: string) => (draft = v)}
            onSubmit={(v: any) => submit(typeof v === "string" ? v : undefined)}
          />
        </Show>
      </box>
    </box>
  )
}

type SettingsRow =
  | { kind: "header"; title: string }
  | { kind: "model"; title: string; help: string }
  | { kind: "toggle"; title: string; help: string; get: (d: Settings) => boolean; set: (d: Settings, v: boolean) => Settings }

const SETTINGS_ROWS: SettingsRow[] = [
  { kind: "header", title: "Side model" },
  { kind: "model", title: "Model", help: "Which model answers /btw-cloud side questions. Space opens the picker." },
  { kind: "header", title: "Behavior" },
  {
    kind: "toggle",
    title: "Tell side model who wrote history",
    help: "On: it knows the main session's model wrote the earlier replies and reviews them as an outsider. Off: it treats them as its own.",
    get: (d) => d.attribution,
    set: (d, v) => ({ ...d, attribution: v }),
  },
  { kind: "header", title: "Stats under each answer" },
  ...STATS.map(
    ({ key, title }): SettingsRow => ({
      kind: "toggle",
      title,
      help: {
        time: "How long the answer took.",
        speed: "Output tokens per second, over the whole request (so a little lower than OpenCode's own figure).",
        context: "Tokens the side model used, and the share of its context window.",
        cost: "What the answer cost, as reported by the provider ($0.00 for free models).",
      }[key],
      get: (d) => d.stats[key],
      set: (d, v) => ({ ...d, stats: { ...d.stats, [key]: v } }),
    }),
  ),
]

function SettingsView(props: {
  context: any
  draft: Settings
  selected: number
  model: () => ModelRef | undefined
  onSave: (next: Settings) => void
  onPickModel: (next: Settings, selected: number) => void
}) {
  const t = props.context.theme.surface?.("dialog") ?? props.context.theme
  const raised = t?.background?.raised?.high
  const muted = t?.text?.muted
  const base = t?.text?.base
  const blue = t?.hue?.blue?.[400] ?? props.context.theme?.hue?.blue?.[400] ?? "#4c8dff"
  const dims = useTerminalDimensions()
  const [draft, setDraft] = createSignal<Settings>({ ...props.draft, stats: { ...props.draft.stats } })

  // indexes of the selectable rows (everything but headers)
  const items = SETTINGS_ROWS.flatMap((r, i) => (r.kind === "header" ? [] : [i]))
  const [sel, setSel] = createSignal(Math.max(0, Math.min(props.selected, items.length - 1)))
  const current = () => SETTINGS_ROWS[items[sel()]] as Exclude<SettingsRow, { kind: "header" }>
  const refs: any[] = []
  let box: any
  // ignore the enter that opened this dialog
  let ready = false
  setTimeout(() => (ready = true), 50)

  const act = (k = sel()) => {
    const row = SETTINGS_ROWS[items[k]]
    if (row.kind === "model") return props.onPickModel(draft(), k)
    if (row.kind === "toggle") setDraft((d) => row.set(d, !row.get(d)))
  }
  const select = (k: number) => {
    const next = Math.max(0, Math.min(items.length - 1, k))
    setSel(next)
    const el = refs[items[next]]
    if (el) box?.scrollChildIntoView?.(el)
  }

  useKeyboard((key: any) => {
    if (!ready) return
    if (key.name === "up" || key.name === "k") return select(sel() - 1)
    if (key.name === "down" || key.name === "j") return select(sel() + 1)
    if (key.name === "home") return select(0)
    if (key.name === "end") return select(items.length - 1)
    if (key.name === "space") return act()
    if (key.name === "return" || key.name === "enter") return props.onSave(draft())
  })

  const Hint = (p: { label: string; keys: string }) => <KeyHint label={p.label} keys={p.keys} fg={base} muted={muted} />

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={base} attributes={1} flexGrow={1}>
          /btw-cloud settings
        </text>
        <text fg={muted} flexShrink={0}>
          esc
        </text>
      </box>

      <scrollbox
        ref={(el: any) => (box = el)}
        maxHeight={Math.max(6, Math.floor(dims().height * 0.5))}
        contentOptions={{ minHeight: 0 }}
        verticalScrollbarOptions={scrollbar(t, raised)}
        backgroundColor={raised}
      >
        <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
          <For each={SETTINGS_ROWS}>
            {(row, i) => {
              if (row.kind === "header")
                return (
                  <box paddingLeft={1} paddingTop={1} ref={(el: any) => (refs[i()] = el)}>
                    <text fg={muted} attributes={1}>
                      {row.title}
                    </text>
                  </box>
                )
              const k = items.indexOf(i())
              const on = () => sel() === k
              return (
                <box
                  ref={(el: any) => (refs[i()] = el)}
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => {
                    setSel(k)
                    act(k)
                  }}
                >
                  <text fg={blue} flexShrink={0}>
                    {on() ? "▌" : " "}
                  </text>
                  <Show
                    when={row.kind === "toggle" ? row : undefined}
                    fallback={
                      <>
                        <text fg={muted} flexShrink={0}>
                          ›
                        </text>
                        <text fg={base} attributes={on() ? 1 : 0} flexGrow={1}>
                          {row.title}
                        </text>
                        <text fg={muted} wrapMode="none" truncate flexShrink={1}>
                          {(() => {
                            const m = props.model()
                            return m ? label(m) : "not set"
                          })()}
                        </text>
                      </>
                    }
                  >
                    {(tog) => (
                      <>
                        <text fg={tog().get(draft()) ? blue : muted} flexShrink={0}>
                          {tog().get(draft()) ? "●" : "○"}
                        </text>
                        <text fg={base} attributes={on() ? 1 : 0} flexGrow={1}>
                          {tog().title}
                        </text>
                      </>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>

      <box paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={muted}>{current().help}</text>
      </box>

      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <Hint label="move" keys="↑/↓" />
        <Hint label={current().kind === "model" ? "change model" : "toggle"} keys="space" />
        <Hint label="save" keys="enter" />
        <Hint label="cancel" keys="esc" />
      </box>
    </box>
  )
}
