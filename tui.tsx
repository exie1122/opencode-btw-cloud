/** @jsxImportSource @opentui/solid */
// opencode-btw-cloud: like the built-in /btw, but answered by a model you choose
// (typically a fast cloud model while your main session runs on a local LLM).
//
// How a question is answered:
//   1. fork the current session (copies the full native history, ~instant)
//   2. switch the fork to the chosen model
//   3. session.generate on the fork (the same one-shot, tool-free call /btw uses)
//   4. delete the fork and show the answer in a popup
//      (press "o" to open a fresh copy of the session on the chosen model)
// The main session, its model and its local KV cache are never touched.
import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"

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

    // "o": open a fresh copy of the session on the side model (forks are cheap).
    const openAsSession = async (sessionID: string, model: ModelRef) => {
      try {
        const id = await forkOnto(sessionID, model)
        await untrack(id) // kept on purpose: it's a real session now
        context.ui.router.navigate({ type: "session", sessionID: id })
      } catch (err: any) {
        toast(String(err?.message ?? err), "error")
      }
    }

    const showAnswer = (sessionID: string, question: string, answer: string, model: ModelRef) => {
      const style = SyntaxStyle.fromStyles({ default: { fg: theme()?.text?.base } }, context.renderer.nativeScene)
      context.ui.dialog.show(
        () => (
          <AnswerView
            context={context}
            question={question}
            answer={answer}
            model={model}
            style={style}
            onKeep={() => {
              context.ui.dialog.clear()
              void openAsSession(sessionID, model)
            }}
          />
        ),
        () => context.renderer.idle?.().then(() => style.destroy()),
      )
      context.ui.dialog.set({ size: "large", centered: true })
    }

    const ask = async (sessionID: string, question: string, model: ModelRef) => {
      setPending((n) => n + 1)
      let forkID: string | undefined
      try {
        forkID = await forkOnto(sessionID, model)
        const res = unwrap<any>(
          await context.client.session.generate({ sessionID: forkID, prompt: [PREAMBLE, question].join("\n\n") }),
        )
        await removeFork(forkID).catch(() => {})
        forkID = undefined
        showAnswer(sessionID, question, String(res?.text ?? "").trim() || "_(empty response)_", model)
      } catch (err: any) {
        if (forkID) await removeFork(forkID).catch(() => {})
        toast(String(err?.message ?? err), "error")
      } finally {
        setPending((n) => n - 1)
      }
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
  question: string
  answer: string
  model: ModelRef
  style: SyntaxStyle
  onKeep: () => void
}) {
  const t = props.context.theme
  const raised = t?.background?.raised?.high
  const dims = useTerminalDimensions()
  const [copied, setCopied] = createSignal(false)
  let box: any

  const copy = () => {
    try {
      const ok = props.context.renderer.copyToClipboardOSC52?.(props.answer)
      if (ok === false || ok === undefined) throw new Error("unsupported")
      setCopied(true)
    } catch {
      props.context.ui.toast.show({ message: "Clipboard copy is not supported in this terminal", variant: "warning" })
    }
  }

  useKeyboard((key: any) => {
    if (key.name === "c") return copy()
    if (key.name === "o") return props.onKeep()
    if (!box) return
    const page = Math.max(8, Math.floor(dims().height * 0.6))
    if (key.name === "up" || key.name === "k") return box.scrollBy(-1)
    if (key.name === "down" || key.name === "j") return box.scrollBy(1)
    if (key.name === "pageup") return box.scrollBy(-page)
    if (key.name === "pagedown") return box.scrollBy(page)
    if (key.name === "home") return box.scrollTo(0)
    if (key.name === "end") return box.scrollTo(box.scrollHeight)
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
        <text fg={t?.text?.base} attributes={1} flexShrink={0}>
          /btw-cloud
        </text>
        <text fg={t?.text?.muted} wrapMode="none" truncate flexGrow={1}>
          {props.question.replace(/\s+/g, " ")}
        </text>
        <text fg={t?.text?.muted} flexShrink={0}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(el: any) => (box = el)}
        maxHeight={Math.max(8, Math.floor(dims().height * 0.6))}
        contentOptions={{ minHeight: 0 }}
        scrollbarOptions={{ visible: false }}
        backgroundColor={raised}
      >
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <markdown
            content={props.answer}
            syntaxStyle={props.style}
            conceal
            internalBlockMode="top-level"
            tableOptions={{ style: "grid", cellPaddingX: 1 }}
            fg={t?.markdown?.text ?? t?.text?.base}
            bg={raised}
          />
        </box>
      </scrollbox>
      <box paddingLeft={2} paddingRight={2}>
        <text fg={t?.text?.muted}>
          {copied() ? "✓ copied" : "c copy"}
          {"  o open as session  j/k scroll  ·  "}
          {props.model.id}
        </text>
      </box>
    </box>
  )
}
