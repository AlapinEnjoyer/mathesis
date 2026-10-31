// @bun
// src/tui.tsx
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { rm as rm2 } from "fs/promises";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, on, Show } from "solid-js";

// src/notify.ts
var localDate = (now) => now.toLocaleDateString("sv");
function shouldNotify(input) {
  return input.enabled && input.due > 0 && input.last !== input.today && !input.reviewing;
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
var str = { type: "string" };
var bool = { type: "boolean" };
var modelRef = obj({ providerID: str, id: str, variant: str }, ["providerID", "id"]);
var formSpec = {
  type: "object",
  properties: {
    id: str,
    title: str,
    fields: { type: "array", items: { type: "object" } },
    metadata: { type: "object" }
  },
  required: ["id", "title", "fields"]
};
var Mathesis = Rpc.define({
  id: "mathesis",
  methods: {
    claim: {
      input: obj({ questionID: str }, ["questionID"]),
      output: obj({ accepted: bool, sessionID: str, form: formSpec }, ["accepted"])
    },
    shown: {
      input: obj({ formID: str }, ["formID"]),
      output: obj({ accepted: bool }, ["accepted"])
    },
    relay: {
      input: obj({ formID: str, answer: { type: "object" }, cancelled: bool, message: str }, ["formID"]),
      output: obj({ accepted: bool }, ["accepted"])
    },
    dictation: {
      input: obj({ formID: str, text: str, undo: bool }, ["formID"]),
      output: obj({ accepted: bool, count: { type: "number" } }, ["accepted", "count"])
    },
    pending: {
      input: obj({ sessionID: str }),
      output: obj({
        questions: {
          type: "array",
          items: obj({ questionID: str, sessionID: str, title: str, claimed: bool, form: formSpec }, [
            "questionID",
            "sessionID",
            "title",
            "claimed",
            "form"
          ])
        }
      }, ["questions"])
    },
    start: {
      input: obj({
        kind: { type: "string", enum: ["learn", "recall", "practice"] },
        goal: str,
        topic: str,
        model: modelRef,
        directory: str
      }, ["kind"]),
      output: obj({ sessionID: str, title: str, notice: str }, ["sessionID", "title"]),
      errors: { invalid: obj({ reason: str }, ["reason"]) }
    },
    topics: {
      input: obj({}),
      output: obj({
        topics: {
          type: "array",
          items: obj({ id: str, goal: str, ideas: { type: "number" }, due: { type: "number" } }, [
            "id",
            "goal",
            "ideas",
            "due"
          ])
        }
      }, ["topics"])
    },
    status: {
      input: obj({}),
      output: obj({ due: { type: "number" }, cards: { type: "number" }, text: str }, ["due", "cards", "text"])
    },
    panel: {
      input: obj({ sessionID: str }, ["sessionID"]),
      output: obj({
        title: str,
        rows: { type: "array", items: obj({ depth: { type: "number" }, text: str, tone: str }, ["depth", "text"]) }
      }, ["title", "rows"])
    },
    due: {
      input: obj({}),
      output: obj({ due: { type: "number" }, next: str, setupNeeded: bool }, ["due"])
    },
    setup: {
      input: obj({
        models: obj({ teach: modelRef, recall: modelRef, background: modelRef }),
        sameModel: bool
      }),
      output: obj({ agentFile: str, vault: str, created: bool, models: { type: "object" } }, [
        "agentFile",
        "vault",
        "created",
        "models"
      ])
    }
  },
  events: {
    questionAsked: { schema: obj({ questionID: str, sessionID: str, title: str }, ["questionID", "sessionID", "title"]) },
    questionClosed: {
      schema: obj({ questionID: str, sessionID: str, formID: str, reason: { type: "string", enum: ["answered", "cancelled", "aborted", "fallback"] } }, ["questionID", "sessionID", "formID", "reason"])
    },
    planUpdated: { schema: obj({ sessionID: str, topic: str }, ["sessionID", "topic"]) },
    sessionChanged: { schema: obj({ sessionID: str }, ["sessionID"]) },
    cardsChanged: {
      schema: obj({ sessionID: str, added: { type: "array", items: str }, updated: { type: "array", items: str } }, [
        "added",
        "updated"
      ])
    }
  }
});

// src/voice.ts
import { randomUUID } from "crypto";
import { rm, stat } from "fs/promises";
import { platform, tmpdir } from "os";
import { join as join2 } from "path";

// src/config.ts
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
function expandHome(path, home = homedir()) {
  if (path === "~")
    return home;
  if (path.startsWith("~/"))
    return join(home, path.slice(2));
  return path;
}

// src/voice.ts
var RECORD = {
  darwin: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000", "-y", "{file}"],
  linux: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-y", "{file}"]
};
var PLAY = {
  darwin: ["afplay", "{file}"],
  linux: ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", "{file}"]
};
var strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string") ? value : undefined;
var text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
function endpoint(value) {
  if (!value || typeof value !== "object")
    return;
  const raw = value;
  const command = strings(raw.command);
  if (command)
    return { command };
  const url = text(raw.url);
  const model = text(raw.model);
  if (!url || !model)
    return;
  const voice = text(raw.voice);
  const apiKeyEnv = text(raw.apiKeyEnv);
  return { url, model, ...voice ? { voice } : {}, ...apiKeyEnv ? { apiKeyEnv } : {} };
}
function parseVoice(value, os = platform()) {
  const raw = value && typeof value === "object" ? value : {};
  const stt = endpoint(raw.stt);
  const tts = endpoint(raw.tts);
  return {
    record: strings(raw.record) ?? RECORD[os] ?? RECORD.linux,
    play: strings(raw.play) ?? PLAY[os] ?? PLAY.linux,
    ...stt ? { stt } : {},
    ...tts ? { tts } : {},
    autoRead: raw.autoRead === true,
    dictateKey: text(raw.dictateKey) ?? "<leader>v",
    undoKey: text(raw.undoKey) ?? "<leader>z",
    readKey: text(raw.readKey) ?? "<leader>o"
  };
}
var expand = (args, file) => args.map((arg) => expandHome(arg.replaceAll("{file}", file)));
var tempFile = (ext) => join2(tmpdir(), `mathesis-${randomUUID()}.${ext}`);
async function run(args, stdin) {
  const proc = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0)
    throw new Error(`${args[0]} failed (${code}): ${err.trim().slice(0, 300)}`);
  return out;
}
function authorization(endpoint2) {
  if (!endpoint2.apiKeyEnv)
    return {};
  const key = process.env[endpoint2.apiKeyEnv];
  if (!key)
    throw new Error(`${endpoint2.apiKeyEnv} is not set`);
  return { Authorization: `Bearer ${key}` };
}
function startRecording(config) {
  const file = tempFile("wav");
  const proc = Bun.spawn(expand(config.record, file), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return {
    async stop() {
      proc.kill("SIGINT");
      const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      const size = await stat(file).then((info) => info.size, () => 0);
      if (size <= 44) {
        await rm(file, { force: true });
        throw new Error(`no audio was recorded${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`);
      }
      return file;
    },
    cancel() {
      proc.kill();
      proc.exited.then(() => rm(file, { force: true }));
    }
  };
}
var oneLine = (text2) => text2.replace(/\s+/g, " ").trim();
async function transcribe(endpoint2, file, fetchImpl = fetch) {
  if ("command" in endpoint2)
    return oneLine(await run(expand(endpoint2.command, file)));
  const body = new FormData;
  body.append("file", Bun.file(file), "speech.wav");
  body.append("model", endpoint2.model);
  const response = await fetchImpl(endpoint2.url, { method: "POST", headers: authorization(endpoint2), body });
  if (!response.ok)
    throw new Error(`transcription failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const result = await response.json();
  return typeof result.text === "string" ? oneLine(result.text) : "";
}
function speak(config, endpoint2, text2, fetchImpl = fetch) {
  let proc;
  let stopped = false;
  const start = (args, stdin) => {
    proc = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "ignore", stderr: "ignore" });
    return proc.exited;
  };
  const done = (async () => {
    if ("command" in endpoint2)
      return void await start(expand(endpoint2.command, ""), text2);
    const response = await fetchImpl(endpoint2.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorization(endpoint2) },
      body: JSON.stringify({ model: endpoint2.model, input: text2, response_format: "wav", ...endpoint2.voice ? { voice: endpoint2.voice } : {} })
    });
    if (!response.ok)
      throw new Error(`speech failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const file = tempFile("wav");
    await Bun.write(file, await response.arrayBuffer());
    try {
      if (!stopped)
        await start(expand(config.play, file));
    } finally {
      await rm(file, { force: true });
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      proc?.kill();
    }
  };
}
function spokenQuestion(form) {
  const answer = form.fields.find((field) => field.key === "answer");
  const choices = (answer?.options ?? []).filter((option) => /^\d+$/.test(option.value));
  return [form.title, ...choices.map((option, index) => `${String.fromCharCode(65 + index)}: ${option.label}.`)].join(`
`);
}

// src/tui.tsx
var FORM_PREFIX = "frm_mathesis_";
var PANEL = "mathesis.panel";
var DUE_REFRESH_MS = 10 * 60 * 1000;
var errorText = (error) => error && typeof error === "object" && ("message" in error) ? String(error.message) : String(error);
var tui_default = Plugin.define({
  id: "mathesis.tui",
  setup(context) {
    const rpc = () => context.client.rpc(Mathesis);
    const stops = [];
    const here = () => context.location ?? context.data.location.default();
    const at = (location) => ({
      location: location ?? here()
    });
    const locationOf = (event) => event.location;
    const formLocations = new Map;
    const voice = parseVoice(context.options.voice);
    const openForms = new Map;
    let recording;
    const [dictation, setDictation] = createSignal({
      state: "idle",
      counts: {}
    });
    const setCount = (formID, count) => setDictation((d) => ({
      ...d,
      counts: {
        ...d.counts,
        [formID]: count
      }
    }));
    let playback;
    const viewing = (sessionID) => {
      const route = context.ui.router.current();
      return route.type === "session" && route.sessionID === sessionID;
    };
    async function showForm(sessionID, form, location) {
      formLocations.set(form.id, location);
      try {
        try {
          await context.client.session.form.create({
            sessionID,
            ...form
          });
        } catch (error) {
          const existing = await context.client.session.form.get({
            sessionID,
            formID: form.id
          }).catch(() => {
            return;
          });
          if (!existing)
            throw error;
        }
        await rpc().shown({
          formID: form.id
        }, at(location));
      } catch (error) {
        await rpc().relay({
          formID: form.id,
          cancelled: true,
          message: `the form could not be shown: ${errorText(error)}`
        }, at(location)).catch(() => {});
        throw error;
      }
      openForms.set(sessionID, {
        form,
        location
      });
      if (voice.autoRead && voice.tts && viewing(sessionID))
        speakForm(form);
      if (!viewing(sessionID)) {
        context.ui.toast.show({
          title: "Mathesis question",
          message: form.title,
          sessionID,
          variant: "info",
          duration: 8000
        });
        context.attention.notify({
          title: "Mathesis",
          message: form.title,
          notification: {
            when: "blurred"
          },
          sound: {
            name: "question"
          }
        });
      }
    }
    async function claimAndShow(questionID, location) {
      const claim = await rpc().claim({
        questionID
      }, at(location));
      if (claim.accepted && claim.sessionID && claim.form)
        await showForm(claim.sessionID, claim.form, location);
    }
    async function recover() {
      const {
        questions
      } = await rpc().pending({}, at());
      for (const question of questions) {
        if (!question.claimed) {
          await claimAndShow(question.questionID);
          continue;
        }
        const detail = await context.client.session.form.get({
          sessionID: question.sessionID,
          formID: question.form.id
        }).catch(() => {
          return;
        });
        if (!detail)
          await showForm(question.sessionID, question.form);
        else if (detail.state?.status === "answered")
          await rpc().relay({
            formID: question.form.id,
            answer: detail.state.answer
          }, at());
        else if (detail.state?.status === "cancelled") {
          await rpc().relay({
            formID: question.form.id,
            cancelled: true,
            ...detail.state.message ? {
              message: detail.state.message
            } : {}
          }, at());
        } else {
          await rpc().shown({
            formID: question.form.id
          }, at());
          openForms.set(question.sessionID, {
            form: question.form
          });
        }
      }
    }
    const [tick, bump] = createSignal(0);
    const changed = () => void bump((n) => n + 1);
    function subscribe() {
      return [rpc().events.on("planUpdated", changed), rpc().events.on("sessionChanged", changed), rpc().events.on("questionAsked", (event) => {
        changed();
        claimAndShow(event.data.questionID, locationOf(event)).catch((error) => context.ui.toast.show({
          title: "Mathesis",
          message: `Could not show the question: ${errorText(error)}`,
          variant: "error"
        }));
      }), rpc().events.on("questionClosed", (event) => {
        const {
          reason,
          sessionID,
          formID
        } = event.data;
        formLocations.delete(formID);
        for (const [session, open] of openForms)
          if (open.form.id === formID)
            openForms.delete(session);
        if (recording?.formID === formID) {
          recording.recording.cancel();
          recording = undefined;
        }
        setDictation((d) => {
          const {
            [formID]: _,
            ...counts
          } = d.counts;
          return {
            ...d.formID === formID ? {
              state: "idle"
            } : {
              state: d.state,
              formID: d.formID
            },
            counts
          };
        });
        changed();
        if (reason === "aborted" || reason === "fallback") {
          context.client.session.form.cancel({
            sessionID,
            formID,
            message: "The question was closed."
          }).catch(() => {});
        }
      }), rpc().events.on("cardsChanged", (event) => {
        for (const id of event.data.added)
          context.ui.toast.show({
            message: `+1 card: ${id}`,
            variant: "success",
            duration: 3000
          });
        changed();
        refreshDue().catch(() => {});
      })];
    }
    let subscriptions = subscribe();
    stops.push(() => subscriptions.forEach((off) => off()), context.data.on("server.connected", () => {
      subscriptions.forEach((off) => off());
      subscriptions = subscribe();
      recover().catch(() => {});
      changed();
      refreshDue({
        notify: true
      }).catch(() => {});
    }), context.data.on("form.replied", (event) => {
      const id = event.data.id;
      if (id.startsWith(FORM_PREFIX))
        rpc().relay({
          formID: id,
          answer: event.data.answer
        }, at(formLocations.get(id) ?? locationOf(event))).catch(() => {});
    }), context.data.on("form.cancelled", (event) => {
      const id = event.data.id;
      if (id.startsWith(FORM_PREFIX))
        rpc().relay({
          formID: id,
          cancelled: true
        }, at(formLocations.get(id) ?? locationOf(event))).catch(() => {});
    }));
    recover().catch(() => {});
    const currentModel = () => {
      const model = context.ui.model.current();
      return model ? {
        providerID: model.providerID,
        id: model.modelID,
        ...model.variant ? {
          variant: model.variant
        } : {}
      } : undefined;
    };
    let setupOffered = false;
    async function offerSetup() {
      if (setupOffered)
        return;
      const {
        setupNeeded
      } = await rpc().due({}, at()).catch(() => ({}));
      if (!setupNeeded)
        return;
      setupOffered = true;
      const run2 = await context.ui.dialog.confirm({
        title: "Mathesis is not set up yet",
        message: "Setup writes the mathesis agent (its permission rules) and the vault folders, and takes a few seconds. Without it, sessions use the default agent.",
        label: {
          confirm: "Set up now",
          cancel: "Not now"
        }
      });
      if (run2)
        await setupCommand();
    }
    async function start(input) {
      await offerSetup();
      try {
        const directory = here().directory;
        const model = currentModel();
        const result = await rpc().start({
          ...input,
          directory,
          ...model ? {
            model
          } : {}
        }, at());
        context.ui.router.navigate({
          type: "session",
          sessionID: result.sessionID
        });
        if (result.notice)
          context.ui.toast.show({
            title: "Mathesis",
            message: result.notice,
            variant: "warning",
            duration: 8000
          });
      } catch (error) {
        context.ui.toast.show({
          title: "Mathesis",
          message: errorText(error),
          variant: "error",
          duration: 8000
        });
      }
    }
    async function learn(input) {
      const goal = input?.trim();
      if (goal)
        return start({
          kind: "learn",
          goal
        });
      let topics;
      try {
        topics = (await rpc().topics({}, at())).topics;
      } catch (error) {
        return context.ui.toast.show({
          title: "Mathesis",
          message: errorText(error),
          variant: "error"
        });
      }
      const NEW = "\x00new";
      const choice = await context.ui.dialog.select({
        title: "Mathesis: learn",
        placeholder: "Search topics",
        options: [{
          title: "New topic\u2026",
          value: NEW,
          description: "Learn something new"
        }, ...topics.map((t) => ({
          title: t.goal,
          value: t.id,
          description: `${t.ideas} card${t.ideas === 1 ? "" : "s"}${t.due ? `, ${t.due} due` : ""}`,
          category: "Continue"
        }))]
      });
      if (choice === undefined)
        return;
      if (choice !== NEW)
        return start({
          kind: "learn",
          topic: choice
        });
      const typed = await context.ui.dialog.prompt({
        title: "What do you want to understand?",
        placeholder: "how binary search finds its bounds"
      });
      if (typed?.trim())
        return start({
          kind: "learn",
          goal: typed.trim()
        });
    }
    const topicArg = (input) => input?.trim() ? input.trim() : undefined;
    async function showStatus() {
      try {
        const result = await rpc().status({}, at());
        await context.ui.dialog.alert({
          title: "Mathesis",
          message: result.text
        });
      } catch (error) {
        context.ui.toast.show({
          title: "Mathesis",
          message: errorText(error),
          variant: "error"
        });
      }
    }
    async function setupCommand() {
      const same = await context.ui.dialog.confirm({
        title: "Mathesis setup",
        message: "Use one model for everything? (Recommended: the session's model is used for teaching, review and background work.)",
        label: {
          confirm: "Yes, one model",
          cancel: "No, choose models"
        }
      });
      if (same === undefined)
        return;
      let models;
      if (same === false) {
        await context.data.location.model.sync(context.location);
        const available = context.data.location.model.list(context.location) ?? [];
        models = {};
        for (const [role, label] of [["teach", "teaching (probe, plan, teach, practice)"], ["recall", "spaced review (/recall)"], ["background", "background work (summaries)"]]) {
          const DEFAULT = "\x00default";
          const value = await context.ui.dialog.select({
            title: `Model for ${label}`,
            options: [{
              title: "Same as the session's model",
              value: DEFAULT
            }, ...available.map((m) => ({
              title: m.name,
              value: `${m.providerID}/${m.id}`,
              category: m.providerID
            }))]
          });
          if (value === undefined)
            return;
          if (value !== DEFAULT) {
            const slash = value.indexOf("/");
            models[role] = {
              providerID: value.slice(0, slash),
              id: value.slice(slash + 1)
            };
          }
        }
      }
      try {
        const result = await rpc().setup(same ? {
          sameModel: true
        } : {
          sameModel: false,
          models
        }, at());
        context.ui.toast.show({
          title: "Mathesis is set up",
          message: `Agent: ${context.ui.format.path(result.agentFile)} \xB7 Vault: ${context.ui.format.path(result.vault)}. Start with /learn.`,
          variant: "success",
          duration: 8000
        });
      } catch (error) {
        context.ui.toast.show({
          title: "Mathesis",
          message: errorText(error),
          variant: "error"
        });
      }
    }
    const [due, setDue] = createSignal(0);
    const [notified, setNotified] = context.storage.store("notify", {
      initial: {
        last: ""
      }
    });
    let notifying = false;
    const reviewing = () => {
      const route = context.ui.router.current();
      return route.type === "session" && !!context.data.session.get(route.sessionID)?.title?.startsWith("Mathesis: review");
    };
    async function refreshDue(options = {}) {
      const {
        due: count
      } = await rpc().due({}, at());
      setDue(count);
      const today = localDate(new Date);
      if (!options.notify || notifying)
        return;
      if (!shouldNotify({
        due: count,
        last: notified.last,
        today,
        enabled: context.options.notify !== false,
        reviewing: reviewing()
      }))
        return;
      notifying = true;
      const previous = notified.last;
      try {
        await setNotified((draft) => void (draft.last = today));
        const sent = await context.attention.notify({
          title: "Mathesis",
          message: `${count} card${count === 1 ? "" : "s"} due. Run /recall.`,
          notification: {
            when: "blurred"
          }
        });
        if (!sent.notification)
          await setNotified((draft) => void (draft.last = previous));
      } finally {
        notifying = false;
      }
    }
    refreshDue({
      notify: true
    }).catch(() => {});
    const timer = setInterval(() => {
      changed();
      refreshDue({
        notify: true
      }).catch(() => {});
    }, DUE_REFRESH_MS);
    stops.push(() => clearInterval(timer));
    const dueText = () => `Mathesis: ${due()} due`;
    stops.push(context.ui.slot({
      append: "home.footer.status",
      render: () => _$createComponent(Show, {
        get when() {
          return due() > 0;
        },
        get children() {
          var _el$ = _$createElement("text");
          _$insert(_el$, dueText);
          _$effect((_$p) => _$setProp(_el$, "fg", context.theme.text.muted, _$p));
          return _el$;
        }
      })
    }), context.ui.slot({
      append: "sidebar.content",
      render: () => _$createComponent(Show, {
        get when() {
          return due() > 0;
        },
        get children() {
          var _el$2 = _$createElement("text"), _el$3 = _$createTextNode(` \xB7 /recall`);
          _$insertNode(_el$2, _el$3);
          _$insert(_el$2, dueText, _el$3);
          _$effect((_$p) => _$setProp(_el$2, "fg", context.theme.text.muted, _$p));
          return _el$2;
        }
      })
    }), context.ui.slot({
      append: "session.composer.top",
      render: (input) => _$createComponent(Show, {
        get when() {
          return dictationLine(input.sessionID);
        },
        get children() {
          var _el$4 = _$createElement("text");
          _$insert(_el$4, () => dictationLine(input.sessionID));
          _$effect((_$p) => _$setProp(_el$4, "fg", dictation().state === "recording" ? context.theme.text.base : context.theme.text.muted, _$p));
          return _el$4;
        }
      })
    }), context.ui.slot({
      append: "session.panel",
      render: (input) => _$createComponent(Show, {
        get when() {
          return input.name === PANEL;
        },
        get children() {
          return _$createComponent(MathesisPanel, {
            input
          });
        }
      })
    }));
    function MathesisPanel(props) {
      const [view, setView] = createSignal({
        title: "Mathesis",
        rows: [{
          depth: 0,
          text: "Loading\u2026"
        }]
      });
      let request = 0;
      createEffect(on([() => props.input.sessionID, tick], ([sessionID]) => {
        const id = ++request;
        const location = context.data.session.get(sessionID)?.location;
        rpc().panel({
          sessionID
        }, at(location)).then((result) => id === request && setView(result)).catch((error) => id === request && setView({
          title: "Mathesis",
          rows: [{
            depth: 0,
            text: `Could not load: ${errorText(error)}`
          }]
        }));
      }));
      const color = (tone) => tone === "current" ? context.theme.text.action.primary.base : tone === "muted" ? context.theme.text.muted : context.theme.text.base;
      return (() => {
        var _el$5 = _$createElement("box"), _el$6 = _$createElement("text"), _el$7 = _$createElement("b"), _el$8 = _$createElement("scrollbox");
        _$insertNode(_el$5, _el$6);
        _$insertNode(_el$5, _el$8);
        _$setProp(_el$5, "flexDirection", "column");
        _$setProp(_el$5, "paddingLeft", 1);
        _$setProp(_el$5, "paddingRight", 1);
        _$setProp(_el$5, "flexGrow", 1);
        _$insertNode(_el$6, _el$7);
        _$insert(_el$7, () => view().title);
        _$setProp(_el$8, "flexGrow", 1);
        _$insert(_el$8, _$createComponent(For, {
          get each() {
            return view().rows;
          },
          children: (row) => (() => {
            var _el$9 = _$createElement("box"), _el$0 = _$createElement("text");
            _$insertNode(_el$9, _el$0);
            _$insert(_el$0, (() => {
              var _c$ = _$memo(() => row.tone === "heading");
              return () => _c$() ? (() => {
                var _el$1 = _$createElement("b");
                _$insert(_el$1, () => row.text);
                return _el$1;
              })() : row.text || " ";
            })());
            _$effect((_p$) => {
              var _v$3 = row.depth * 2, _v$4 = color(row.tone);
              _v$3 !== _p$.e && (_p$.e = _$setProp(_el$9, "paddingLeft", _v$3, _p$.e));
              _v$4 !== _p$.t && (_p$.t = _$setProp(_el$0, "fg", _v$4, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$9;
          })()
        }));
        _$effect((_p$) => {
          var _v$ = context.theme.text.action.primary.base, _v$2 = props.input.focused;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$8, "focused", _v$2, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$5;
      })();
    }
    const info = (message, variant = "info", duration = 5000) => context.ui.toast.show({
      title: "Mathesis",
      message,
      variant,
      duration
    });
    async function currentForm() {
      const route = context.ui.router.current();
      if (route.type !== "session")
        return;
      const known = openForms.get(route.sessionID);
      if (known)
        return known;
      const location = context.data.session.get(route.sessionID)?.location;
      const {
        questions
      } = await rpc().pending({
        sessionID: route.sessionID
      }, at(location)).catch(() => ({
        questions: []
      }));
      const question = questions.find((q) => q.sessionID === route.sessionID && q.claimed);
      if (!question)
        return;
      const open = {
        form: question.form,
        ...location ? {
          location
        } : {}
      };
      openForms.set(route.sessionID, open);
      changed();
      return open;
    }
    async function dictate() {
      if (recording) {
        const {
          recording: active,
          formID,
          location
        } = recording;
        recording = undefined;
        setDictation((d) => ({
          ...d,
          state: "transcribing",
          formID
        }));
        let file;
        try {
          file = await active.stop();
          const text2 = await transcribe(voice.stt, file);
          if (!text2)
            return info("Nothing was heard.", "warning");
          const {
            accepted,
            count
          } = await rpc().dictation({
            formID,
            text: text2
          }, at(location));
          if (accepted) {
            setCount(formID, count);
            info(`Spoken thinking added: ${text2}`, "success", 8000);
          } else
            info("The question was already closed.", "warning");
        } catch (error) {
          info(`Dictation failed: ${errorText(error)}`, "error", 8000);
        } finally {
          setDictation((d) => d.formID === formID ? {
            ...d,
            state: "idle"
          } : d);
          if (file)
            await rm2(file, {
              force: true
            });
        }
        return;
      }
      if (!voice.stt)
        return info("Dictation is off: set the plugin option voice.stt.");
      const open = await currentForm();
      if (!open)
        return info("No open Mathesis question in this session.");
      try {
        recording = {
          recording: startRecording(voice),
          formID: open.form.id,
          location: open.location
        };
        setDictation((d) => ({
          ...d,
          state: "recording",
          formID: open.form.id
        }));
        info("Recording\u2026 press again to stop.", "info", 3000);
      } catch (error) {
        info(`Could not start recording: ${errorText(error)}`, "error", 8000);
      }
    }
    async function undoDictation() {
      const open = await currentForm();
      if (!open)
        return info("No open Mathesis question in this session.");
      try {
        const {
          accepted,
          count
        } = await rpc().dictation({
          formID: open.form.id,
          undo: true
        }, at(open.location));
        setCount(open.form.id, count);
        info(accepted ? `Last dictation removed${count ? ` (${count} left)` : ""}.` : "Nothing dictated for this question.", accepted ? "success" : "info");
      } catch (error) {
        info(errorText(error), "error");
      }
    }
    const key = (id) => context.keymap.shortcuts(id)[0];
    function dictationLine(sessionID) {
      const d = dictation();
      tick();
      const formID = openForms.get(sessionID)?.form.id;
      if (!formID)
        return;
      const stop = key("mathesis.dictate");
      if (d.formID === formID && d.state === "recording")
        return `\u25CF Recording your thinking${stop ? ` \xB7 ${stop} to stop` : ""}`;
      if (d.formID === formID && d.state === "transcribing")
        return "Transcribing\u2026";
      const count = d.counts[formID] ?? 0;
      if (!count)
        return;
      const undo = key("mathesis.dictate-undo");
      return `Spoken thinking attached (${count}), added when you submit${undo ? ` \xB7 ${undo} removes the last` : ""}`;
    }
    function speakForm(form) {
      playback?.stop();
      const current = speak(voice, voice.tts, spokenQuestion(form));
      playback = current;
      current.done.catch((error) => info(`Read-aloud failed: ${errorText(error)}`, "error", 8000)).finally(() => {
        if (playback === current)
          playback = undefined;
      });
    }
    async function readAloud() {
      if (playback) {
        playback.stop();
        playback = undefined;
        return;
      }
      if (!voice.tts)
        return info("Read-aloud is off: set the plugin option voice.tts.");
      const open = await currentForm();
      if (!open)
        return info("No open Mathesis question in this session.");
      speakForm(open.form);
    }
    stops.push(() => {
      recording?.recording.cancel();
      playback?.stop();
    });
    function togglePanel() {
      const route = context.ui.router.current();
      const current = context.ui.panel.current();
      if (current?.name === PANEL && route.type === "session" && current.sessionID === route.sessionID)
        return context.ui.panel.close();
      if (!context.ui.panel.open(PANEL))
        context.ui.toast.show({
          message: "Open a session first.",
          variant: "info"
        });
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "mathesis.learn",
        title: "Mathesis: learn a topic",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "learn",
          arguments: true
        },
        run: (input) => learn(input)
      }, {
        id: "mathesis.recall",
        title: "Mathesis: spaced review of due cards",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "recall",
          arguments: true
        },
        run: async (input) => {
          const topic = topicArg(input);
          if (!topic) {
            const count = await rpc().due({}, at()).catch(() => {
              return;
            });
            if (count?.due === 0) {
              const message = count.next ? `No cards are due. Next review: ${count.next}.` : "No cards yet. Learn something with /learn first.";
              return context.ui.toast.show({
                title: "Mathesis",
                message,
                variant: "info"
              });
            }
          }
          return start({
            kind: "recall",
            topic
          });
        }
      }, {
        id: "mathesis.practice",
        title: "Mathesis: practice with what you hold",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "practice",
          arguments: true
        },
        run: (input) => start({
          kind: "practice",
          topic: topicArg(input)
        })
      }, {
        id: "mathesis.status",
        title: "Mathesis: status",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "mathesis",
          arguments: true
        },
        run: (input) => input?.trim() === "panel" ? togglePanel() : showStatus()
      }, {
        id: "mathesis.panel",
        title: "Mathesis: toggle the side panel",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "mathesis-panel"
        },
        ...typeof context.options.panelKey === "string" ? {
          bind: context.options.panelKey
        } : {},
        run: () => togglePanel()
      }, {
        id: "mathesis.setup",
        title: "Mathesis: setup",
        group: "Mathesis",
        palette: true,
        slash: {
          name: "mathesis-setup"
        },
        run: () => setupCommand()
      }],
      bindings: ["mathesis.panel"]
    }));
    context.keymap.layer(() => ({
      mode: "global",
      priority: 1000,
      commands: [{
        id: "mathesis.dictate",
        title: "Mathesis: dictate thinking for the open question",
        group: "Mathesis",
        palette: true,
        ...voice.stt ? {
          bind: voice.dictateKey
        } : {},
        run: () => dictate()
      }, {
        id: "mathesis.dictate-undo",
        title: "Mathesis: remove the last dictation",
        group: "Mathesis",
        palette: true,
        ...voice.stt ? {
          bind: voice.undoKey
        } : {},
        run: () => undoDictation()
      }, {
        id: "mathesis.read",
        title: "Mathesis: read the open question aloud",
        group: "Mathesis",
        palette: true,
        ...voice.tts ? {
          bind: voice.readKey
        } : {},
        run: () => readAloud()
      }],
      bindings: ["mathesis.dictate", "mathesis.dictate-undo", "mathesis.read"]
    }));
    return () => stops.forEach((stop) => stop());
  }
});
export {
  tui_default as default
};
