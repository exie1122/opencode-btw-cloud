/** @jsxImportSource @opentui/solid */
// opencode-btw-cloud: like the built-in /btw, but answered by a model you choose
// (typically a fast cloud model while your main session runs on a local LLM).
//
// How a question is answered:
//   1. fork the current session (copies the full native history, ~instant)
//   2. switch the fork to the chosen model
//   3. session.generate on the fork (the same one-shot, tool-free call /btw uses)
//   4. show the answer in a popup; "f" asks a follow-up on the same fork
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

const unwrap = <T,>(r: any): T => (r && typeof r === "object" && "data" in r && Object.keys(r).length <= 2 ? r.data : r)

const parseModel = (s: unknown): ModelRef | undefined => {
  if (typeof s !== "string") return
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return
  return { providerID: s.slice(0, i), id: s.slice(i + 1) }
}

const label = (m: ModelRef) => `${m.providerID}/${m.id}`

type Turn = { q: string; a?: string; error?: string }

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
    const [saved, setSaved] = context.storage.store("settings", { initial: { model: null as string | null } })
    const read = () => (typeof saved === "function" ? saved() : saved)
    const currentModel = (): ModelRef | undefined => parseModel(read()?.model) ?? parseModel(context.options?.model)

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

      const answer = async (q: string, history: Turn[]) => {
        const prompt =
          history.length === 0
            ? [PREAMBLE, q].join("\n\n")
            : [
                PREAMBLE,
                "This is a follow-up in an ongoing side conversation. Earlier side questions and your answers:",
                history.map((t) => `Q: ${t.q}\n\nA: ${t.a ?? t.error ?? ""}`).join("\n\n---\n\n"),
                `Follow-up question: ${q}`,
              ].join("\n\n")
        const res = unwrap<any>(await context.client.session.generate({ sessionID: forkID, prompt }))
        return String(res?.text ?? "").trim() || "_(empty response)_"
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
          const a = await answer(q, history)
          if (!closed) setLast({ a })
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
        forkID = await forkOnto(sessionID, model)
        const a = await answer(question, [])
        setLast({ a })
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
      ],
    }))
  },
})

function AnswerView(props: {
  context: any
  model: ModelRef
  turns: Accessor<Turn[]>
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

  const Hint = (p: { label: string; keys: string }) => (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={base}>{p.label}</text>
      <text fg={muted}>{p.keys}</text>
    </box>
  )

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
        scrollbarOptions={{ visible: false }}
        backgroundColor={raised}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
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
              <Hint label="scroll" keys="j/k ↑/↓" />
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
