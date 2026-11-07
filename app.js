(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = (prefix) => prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  const now = () => new Date().toISOString();
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };
  const countWords = (text) => (String(text || "").replace(/\s+/g, "").length);
  const safeName = (name) => String(name || "墨引作品").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

  const DB_NAME = "moyin-web";
  const STORE = "projects";
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const request = fn(store);
      t.oncomplete = () => resolve(request && request.result);
      t.onerror = () => reject(t.error);
    });
  }
  const store = {
    all: () => tx("readonly", (s) => s.getAll()),
    get: (id) => tx("readonly", (s) => s.get(id)),
    put: (p) => tx("readwrite", (s) => s.put(p)),
    del: (id) => tx("readwrite", (s) => s.delete(id)),
  };

  const state = { projects: [], currentId: "", currentChapterId: "", saveTimer: null };
  const els = {
    view: $("#view"), list: $("#project-list"), file: $("#file-input"),
    modal: $("#modal-root"), toast: $("#toast"),
  };

  function blankChapter(title) {
    return {
      id: uid("ch"), title: title || "新章节", summary: "", status: "planned", pov: "",
      beats: [], content: "", notes: "", versions: [], createdAt: now(), updatedAt: now(),
    };
  }
  function blankVolume(title) {
    return { id: uid("v"), title: title || "第一卷", summary: "", chapters: [] };
  }
  function blankProject(title, genre) {
    const t = title || "未命名作品";
    const time = now();
    return {
      id: uid("proj"), schema: 1, title: t, author: "", genre: genre || "", tags: [], synopsis: "",
      cover: "", coverImage: "", createdAt: time, updatedAt: time,
      goal: { dailyWords: 2000 },
      style: { pov: "第三人称限知", tone: "", pace: "", taboos: "", sample: "" },
      stats: { days: {}, lastTotal: 0 },
      settings: {
        characters: [], factions: [], relations: [], world: [],
        power: { name: "", overview: "", levels: [], rules: [] },
        powers: [], timeline: [], foreshadowing: [],
      },
      importedDocs: [], volumes: [], snippets: [], aiChat: [], reviews: [],
    };
  }
  function normalizeProject(raw) {
    if (!raw || typeof raw !== "object") return null;
    const p = blankProject(String(raw.title || "导入作品"), String(raw.genre || ""));
    p.id = raw.id || p.id;
    ["author", "tags", "synopsis", "cover", "coverImage", "goal", "style", "stats", "settings",
      "importedDocs", "snippets", "aiChat", "reviews"].forEach((k) => {
      if (raw[k] != null) p[k] = raw[k];
    });
    p.createdAt = raw.createdAt || p.createdAt;
    p.updatedAt = raw.updatedAt || p.updatedAt;
    if (!p.settings || typeof p.settings !== "object") p.settings = blankProject().settings;
    ["characters", "factions", "relations", "world", "powers", "timeline", "foreshadowing"].forEach((k) => {
      if (!Array.isArray(p.settings[k])) p.settings[k] = [];
    });
    if (!Array.isArray(raw.volumes)) p.volumes = [];
    else {
      p.volumes = raw.volumes.map((v) => {
        const volume = blankVolume(String((v && v.title) || "正文"));
        volume.id = (v && v.id) || volume.id;
        volume.summary = (v && v.summary) || "";
        volume.chapters = Array.isArray(v && v.chapters) ? v.chapters.map((c) => {
          const chapter = blankChapter(String((c && c.title) || "未命名"));
          chapter.id = (c && c.id) || chapter.id;
          chapter.content = String((c && c.content) || "");
          chapter.summary = (c && c.summary) || "";
          chapter.notes = (c && c.notes) || "";
          chapter.status = (c && c.status) || "planned";
          chapter.pov = (c && c.pov) || "";
          chapter.beats = Array.isArray(c && c.beats) ? c.beats : [];
          chapter.versions = Array.isArray(c && c.versions) ? c.versions : [];
          chapter.createdAt = (c && c.createdAt) || chapter.createdAt;
          chapter.updatedAt = (c && c.updatedAt) || chapter.updatedAt;
          return chapter;
        }) : [];
        return volume;
      });
    }
    return p;
  }
  function projectWords(p) {
    let n = 0;
    (p.volumes || []).forEach((v) => (v.chapters || []).forEach((c) => { n += countWords(c.content); }));
    return n;
  }
  function chapterCount(p) {
    return (p.volumes || []).reduce((n, v) => n + (v.chapters || []).length, 0);
  }
  function currentProject() { return state.projects.find((p) => p.id === state.currentId) || null; }
  function currentChapter() {
    const p = currentProject();
    if (!p) return null;
    for (const v of p.volumes || []) {
      const c = (v.chapters || []).find((x) => x.id === state.currentChapterId);
      if (c) return { volume: v, chapter: c };
    }
    return null;
  }
  function persist(p) {
    p.updatedAt = now();
    return store.put(p).then(() => {
      state.projects = state.projects.map((x) => (x.id === p.id ? p : x));
      renderSidebar();
    });
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    setSaveState("保存中…");
    state.saveTimer = setTimeout(async () => {
      const p = currentProject();
      if (!p) return;
      try { await persist(p); setSaveState("已保存"); }
      catch (e) { setSaveState("保存失败"); toast("保存失败：" + e.message); }
    }, 500);
  }
  function setSaveState(text) { const el = $(".save-state"); if (el) el.textContent = text; }

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function markdownProject(p) {
    const lines = [`# 《${p.title}》`, ""];
    if (p.author) lines.push(`作者：${p.author}`);
    if (p.genre) lines.push(`类型：${p.genre}`);
    if (p.synopsis) lines.push("", "> " + String(p.synopsis).replace(/\n/g, "\n> "), "");
    (p.volumes || []).forEach((v) => {
      lines.push("---", "", `## ${v.title || "正文"}`, "");
      (v.chapters || []).forEach((c, i) => {
        lines.push(`### 第${i + 1}章　${c.title || "未命名"}`, "", c.content || "*（本章尚未动笔）*", "");
      });
    });
    return lines.join("\n");
  }
  function textProject(p) {
    const lines = [`《${p.title}》`, ""];
    if (p.author) lines.push(`作者：${p.author}`);
    if (p.genre) lines.push(`类型：${p.genre}`);
    if (p.synopsis) lines.push("", "简介：", p.synopsis);
    (p.volumes || []).forEach((v) => {
      lines.push("", `【${v.title || "正文"}】`, "");
      (v.chapters || []).forEach((c, i) => {
        lines.push(`第${i + 1}章　${c.title || "未命名"}`, "", c.content || "（本章尚未动笔）", "");
      });
    });
    return lines.join("\n");
  }

  function openModal(html, onMount) {
    els.modal.innerHTML = `<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const mask = $(".modal-mask", els.modal);
    const close = () => { els.modal.innerHTML = ""; };
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
    $$("[data-close]", els.modal).forEach((b) => b.addEventListener("click", close));
    if (onMount) onMount(els.modal, close);
    return close;
  }

  function renderSidebar() {
    const projects = [...state.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!projects.length) {
      els.list.innerHTML = '<p class="empty-mini">还没有作品。新建一部，或从桌面版导入 JSON。</p>';
      return;
    }
    els.list.innerHTML = projects.map((p) => `
      <button type="button" class="project-item ${p.id === state.currentId ? "active" : ""}" data-project="${esc(p.id)}">
        <strong>${esc(p.title || "未命名")}</strong>
        <span>${projectWords(p).toLocaleString()} 字 · ${fmtDate(p.updatedAt)}</span>
      </button>`).join("");
    $$("[data-project]", els.list).forEach((b) => b.addEventListener("click", () => selectProject(b.dataset.project)));
  }

  function selectProject(id) {
    state.currentId = id || "";
    const p = currentProject();
    if (p) {
      const first = (p.volumes || []).flatMap((v) => v.chapters || [])[0];
      state.currentChapterId = first ? first.id : "";
      location.hash = "#/p/" + encodeURIComponent(p.id);
    } else {
      location.hash = "";
    }
    renderSidebar();
    renderView();
  }

  function renderView() {
    const p = currentProject();
    if (!p) { renderShelf(); return; }
    renderEditor(p);
  }

  function renderShelf() {
    const projects = [...state.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!projects.length) {
      els.view.innerHTML = `
        <section class="welcome">
          <p class="eyebrow">MOYIN / WEB LITE</p>
          <h2>在浏览器里，<br><em>先写起来。</em></h2>
          <p>网页版是精简版：作品只保存在这个浏览器，不含跨设备传输、完整备份和 DOCX 导入。写长篇，仍然推荐 Windows 桌面版。</p>
          <div class="welcome-actions">
            <button class="btn btn-primary" type="button" data-action="new">新建作品</button>
            <button class="btn" type="button" data-action="import">导入桌面版 JSON</button>
            <a class="btn btn-ghost" href="https://gitee.com/AI-moyin/let-writing-be-your-guide/releases" target="_blank" rel="noopener">下载桌面版</a>
          </div>
          <p class="welcome-note">数据只存在本机浏览器（IndexedDB）。清理浏览器数据会丢失作品，请定期导出 JSON 备份。</p>
        </section>`;
      return;
    }
    els.view.innerHTML = `
      <div class="shelf-head">
        <div><h2>我的书架</h2><p>${projects.length} 部作品 · 仅保存在此浏览器</p></div>
        <div class="side-actions" style="margin:0">
          <button class="btn btn-primary btn-sm" type="button" data-action="new">新建作品</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="import">导入</button>
        </div>
      </div>
      <div class="book-grid">
        ${projects.map((p) => `
          <article class="book-card" data-open="${esc(p.id)}" tabindex="0" role="button" aria-label="打开 ${esc(p.title)}">
            <h3>${esc(p.title || "未命名")}</h3>
            <p class="meta">${esc(p.genre || "未分类")} · ${chapterCount(p)} 章<br>更新 ${fmtDate(p.updatedAt)}</p>
            <div class="bar"><span class="words">${projectWords(p).toLocaleString()} 字</span><span class="open">打开 →</span></div>
            <div class="card-actions"><button type="button" data-del="${esc(p.id)}" title="删除">×</button></div>
          </article>`).join("")}
      </div>`;
    $$("[data-open]", els.view).forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        state.currentId = card.dataset.open;
        const p = currentProject();
        const first = (p.volumes || []).flatMap((v) => v.chapters || [])[0];
        state.currentChapterId = first ? first.id : "";
        location.hash = "#/p/" + encodeURIComponent(p.id);
        renderSidebar(); renderView();
      });
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") card.click(); });
    });
    $$("[data-del]", els.view).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const p = state.projects.find((x) => x.id === b.dataset.del);
      if (!p) return;
      if (!confirm(`删除网页版中的《${p.title}》？\n只删除此浏览器里的数据，不会影响桌面版文件。`)) return;
      await store.del(p.id);
      state.projects = state.projects.filter((x) => x.id !== p.id);
      renderSidebar(); renderView(); toast("已删除");
    }));
  }

  function renderEditor(p) {
    const found = currentChapter();
    if (!found && (p.volumes || []).length) {
      const first = p.volumes[0].chapters && p.volumes[0].chapters[0];
      if (first) state.currentChapterId = first.id;
    }
    const current = currentChapter();
    els.view.innerHTML = `
      <div class="editor-head">
        <button class="back-btn" type="button" data-action="back">← 书架</button>
        <input class="title-input" id="project-title" value="${esc(p.title)}" aria-label="作品名" maxlength="120" />
        <span class="save-state">已保存</span>
        <div class="editor-actions">
          <button class="btn btn-sm" type="button" data-action="ai">AI 续写</button>
          <button class="btn btn-sm" type="button" data-action="export">导出</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="delete-project">删除</button>
        </div>
      </div>
      <div class="editor-body">
        <aside class="chapter-pane">
          <h3><span>${chapterCount(p)} 章</span><button type="button" data-action="add-volume" title="新增卷">＋卷</button></h3>
          ${(p.volumes || []).map((v) => `
            <div class="volume-block">
              <div class="volume-title"><span>${esc(v.title || "正文")}</span><button type="button" data-add-chapter="${esc(v.id)}" title="新增章节">＋</button></div>
              <div class="chapter-list">
                ${(v.chapters || []).map((c) => `
                  <button type="button" class="chapter-btn ${c.id === state.currentChapterId ? "active" : ""}" data-chapter="${esc(c.id)}">
                    ${esc(c.title || "未命名")}<small>${countWords(c.content).toLocaleString()}</small>
                  </button>`).join("")}
              </div>
              <button class="add-chapter" type="button" data-add-chapter="${esc(v.id)}">＋ 新章节</button>
            </div>`).join("")}
          ${!(p.volumes || []).length ? '<p class="empty-mini">还没有卷。点击右上角“＋卷”。</p>' : ""}
        </aside>
        <div class="editor-main">
          ${current ? `
            <input class="chapter-title" id="chapter-title" value="${esc(current.chapter.title)}" maxlength="100" aria-label="章节名" />
            <div class="chapter-meta">
              <span>CHAPTER</span>
              <select id="chapter-status" aria-label="章节状态">
                ${[["planned", "计划"], ["draft", "草稿"], ["done", "完成"]].map(([v, t]) => `<option value="${v}" ${current.chapter.status === v ? "selected" : ""}>${t}</option>`).join("")}
              </select>
              <span id="word-count">${countWords(current.chapter.content).toLocaleString()} 字</span>
              <span>· 本机自动保存</span>
            </div>
            <textarea class="editor-text" id="editor-text" placeholder="从这里开始写…" spellcheck="false">${esc(current.chapter.content)}</textarea>
            <div class="editor-foot"><span>WEB LITE · 数据仅保存在此浏览器</span><span>导出 JSON 可回导桌面版</span></div>
          ` : `
            <div class="welcome" style="margin-top:8vh">
              <h2>先建一卷，<br><em>再写第一章。</em></h2>
              <p>网页版不会自动创建章节。</p>
              <div class="welcome-actions"><button class="btn btn-primary" type="button" data-action="add-volume">新增第一卷</button></div>
            </div>`}
        </div>
      </div>`;
    bindEditor(p);
  }

  function bindEditor(p) {
    $("#project-title", els.view).addEventListener("input", (e) => { p.title = e.target.value; scheduleSave(); });
    $$("[data-chapter]", els.view).forEach((b) => b.addEventListener("click", () => {
      state.currentChapterId = b.dataset.chapter;
      renderView();
    }));
    $$("[data-add-chapter]", els.view).forEach((b) => b.addEventListener("click", () => addChapter(p, b.dataset.addChapter)));
    const title = $("#chapter-title", els.view);
    const text = $("#editor-text", els.view);
    const status = $("#chapter-status", els.view);
    const wc = $("#word-count", els.view);
    if (title) title.addEventListener("input", () => {
      const cur = currentChapter(); if (!cur) return;
      cur.chapter.title = title.value; cur.chapter.updatedAt = now(); scheduleSave();
    });
    if (text) text.addEventListener("input", () => {
      const cur = currentChapter(); if (!cur) return;
      cur.chapter.content = text.value; cur.chapter.updatedAt = now();
      if (wc) wc.textContent = countWords(text.value).toLocaleString() + " 字";
      scheduleSave();
    });
    if (status) status.addEventListener("change", () => {
      const cur = currentChapter(); if (!cur) return;
      cur.chapter.status = status.value; scheduleSave();
    });
  }

  async function addChapter(p, volumeId) {
    const v = (p.volumes || []).find((x) => x.id === volumeId) || p.volumes[0];
    if (!v) return;
    const c = blankChapter("第" + ((v.chapters || []).length + 1) + "章");
    v.chapters = v.chapters || []; v.chapters.push(c);
    state.currentChapterId = c.id;
    await persist(p);
    renderView();
  }

  function addVolume(p) {
    openModal(`
      <h2>新增一卷</h2>
      <p class="modal-sub">卷名可以稍后修改。</p>
      <label class="field"><span>卷名</span><input class="input" id="volume-name" value="第${(p.volumes || []).length + 1}卷" /></label>
      <div class="modal-foot"><button class="btn" type="button" data-close="1">取消</button><button class="btn btn-primary" type="button" id="volume-save">创建</button></div>
    `, (root, close) => {
      const input = $("#volume-name", root);
      input.focus(); input.select();
      $("#volume-save", root).addEventListener("click", async () => {
        const v = blankVolume(input.value.trim() || "新卷");
        p.volumes = p.volumes || []; p.volumes.push(v);
        await persist(p); close(); renderView();
      });
    });
  }

  function newProjectModal() {
    openModal(`
      <h2>新建作品</h2>
      <p class="modal-sub">网页版只保存在当前浏览器。建议先写，再导出 JSON 备份。</p>
      <label class="field"><span>作品名</span><input class="input" id="new-title" placeholder="例如：长夜行灯" maxlength="120" /></label>
      <label class="field"><span>类型（可选）</span><input class="input" id="new-genre" placeholder="玄幻 / 悬疑 / 现实…" maxlength="40" /></label>
      <p class="hint">网页版不包含桌面版的完整设定系统、章节历史和跨设备传输。</p>
      <div class="modal-foot"><button class="btn" type="button" data-close="1">取消</button><button class="btn btn-primary" type="button" id="new-save">创建</button></div>
    `, (root, close) => {
      const title = $("#new-title", root);
      title.focus();
      $("#new-save", root).addEventListener("click", async () => {
        const name = title.value.trim();
        if (!name) { toast("先填作品名"); title.focus(); return; }
        const p = blankProject(name, $("#new-genre", root).value.trim());
        const v = blankVolume("第一卷");
        const c = blankChapter("第一章");
        v.chapters.push(c); p.volumes.push(v);
        await store.put(p);
        state.projects.push(p);
        state.currentId = p.id; state.currentChapterId = c.id;
        location.hash = "#/p/" + encodeURIComponent(p.id);
        close(); renderSidebar(); renderView(); toast("已创建");
      });
    });
  }

  function exportModal() {
    const p = currentProject(); if (!p) return;
    openModal(`
      <h2>导出《${esc(p.title)}》</h2>
      <p class="modal-sub">JSON 可以回导桌面版；Markdown / TXT 用于阅读和其他编辑器。</p>
      <div class="modal-foot" style="justify-content:flex-start">
        <button class="btn btn-primary" type="button" data-export="json">导出 JSON</button>
        <button class="btn" type="button" data-export="md">导出 Markdown</button>
        <button class="btn" type="button" data-export="txt">导出 TXT</button>
      </div>
      <p class="hint">桌面版：导入作品 → 选择 JSON 备份。</p>
      <div class="modal-foot"><button class="btn" type="button" data-close="1">关闭</button></div>
    `, (root, close) => {
      $$("[data-export]", root).forEach((b) => b.addEventListener("click", () => {
        const fmt = b.dataset.export;
        if (fmt === "json") download(safeName(p.title) + "-网页版备份.json", JSON.stringify(p, null, 1), "application/json;charset=utf-8");
        if (fmt === "md") download(safeName(p.title) + ".md", markdownProject(p), "text/markdown;charset=utf-8");
        if (fmt === "txt") download(safeName(p.title) + ".txt", textProject(p), "text/plain;charset=utf-8");
        close();
      }));
    });
  }

  async function importFile(file) {
    const text = await file.text();
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".json")) {
      let data;
      try { data = JSON.parse(text); } catch { toast("JSON 解析失败"); return; }
      const rawItems = Array.isArray(data) ? data : (Array.isArray(data.projects) ? data.projects : [data]);
      const items = rawItems.map(normalizeProject).filter(Boolean);
      if (!items.length) { toast("没有识别到作品"); return; }
      for (const p of items) {
        p.id = uid("proj");
        await store.put(p); state.projects.push(p);
      }
      state.currentId = items[0].id;
      const first = (items[0].volumes || []).flatMap((v) => v.chapters || [])[0];
      state.currentChapterId = first ? first.id : "";
      location.hash = "#/p/" + encodeURIComponent(items[0].id);
      renderSidebar(); renderView(); toast(`已导入 ${items.length} 部`);
      return;
    }
    if (/\.(txt|md|markdown)$/.test(lower)) {
      const title = file.name.replace(/\.(txt|md|markdown)$/i, "");
      const p = blankProject(title);
      const v = blankVolume("正文");
      const c = blankChapter("全文");
      c.content = text; v.chapters.push(c); p.volumes.push(v);
      await store.put(p); state.projects.push(p);
      state.currentId = p.id; state.currentChapterId = c.id;
      location.hash = "#/p/" + encodeURIComponent(p.id);
      renderSidebar(); renderView(); toast("已导入文本");
      return;
    }
    toast("仅支持 JSON / TXT / Markdown");
  }

  function aiConfig() {
    try { return JSON.parse(localStorage.getItem("moyin-web-ai") || "{}"); } catch { return {}; }
  }
  function saveAiConfig(cfg) { localStorage.setItem("moyin-web-ai", JSON.stringify(cfg)); }

  function aiModal(mode) {
    const cfg = aiConfig();
    const cur = currentChapter();
    openModal(`
      <h2>${mode === "settings" ? "AI 设置" : "AI 续写"}</h2>
      <p class="modal-sub">网页版直接请求你填写的 AI 接口。仅支持允许浏览器跨域（CORS）的服务商；被拦截时会报错，不会上传到墨引服务器。</p>
      <label class="field"><span>接口地址</span><input class="input" id="ai-endpoint" value="${esc(cfg.endpoint || "https://api.deepseek.com/v1/chat/completions")}" placeholder="https://.../v1/chat/completions" /></label>
      <label class="field"><span>模型</span><input class="input" id="ai-model" value="${esc(cfg.model || "deepseek-chat")}" placeholder="deepseek-chat" /></label>
      <label class="field"><span>API Key</span><input class="input" id="ai-key" type="password" value="${esc(cfg.key || "")}" autocomplete="off" /></label>
      ${mode === "settings" ? "" : `
        <label class="field"><span>续写提示</span><textarea class="textarea" id="ai-prompt" placeholder="例如：顺着当前段落续写 500 字，保持冷峻、克制的语气。">${esc("顺着当前章节最后的内容继续写，保持人物语气和叙事节奏，不要总结，不要解释。")}</textarea></label>
        <p class="hint">会把当前章节正文发送给你填写的服务商；API Key 只保存在此浏览器。</p>`}
      <div class="modal-foot">
        <button class="btn" type="button" data-close="1">取消</button>
        <button class="btn btn-primary" type="button" id="ai-run">${mode === "settings" ? "保存" : "生成"}</button>
      </div>
    `, (root, close) => {
      $("#ai-run", root).addEventListener("click", async () => {
        const endpoint = $("#ai-endpoint", root).value.trim();
        const model = $("#ai-model", root).value.trim();
        const key = $("#ai-key", root).value.trim();
        if (!endpoint || !model || !key) { toast("接口、模型、Key 都要填"); return; }
        saveAiConfig({ endpoint, model, key });
        if (mode === "settings") { close(); toast("AI 设置已保存"); return; }
        const prompt = $("#ai-prompt", root).value.trim();
        const btn = $("#ai-run", root);
        btn.disabled = true; btn.textContent = "生成中…";
        try {
          const content = cur ? String(cur.chapter.content || "").slice(-10000) : "";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: "你是墨引的写作助手。只输出续写正文，不解释、不总结、不加标题。" },
                { role: "user", content: `当前章节正文：\n${content}\n\n要求：${prompt}` },
              ],
              temperature: 0.85,
            }),
          });
          if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
          const data = await res.json();
          const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (!out) throw new Error("接口没有返回正文");
          const textEl = $("#editor-text", els.view);
          if (textEl && cur) {
            const start = textEl.selectionStart ?? textEl.value.length;
            const insert = (start > 0 && !/\n$/.test(textEl.value.slice(0, start)) ? "\n\n" : "") + out.trim();
            textEl.value = textEl.value.slice(0, start) + insert + textEl.value.slice(start);
            cur.chapter.content = textEl.value;
            textEl.dispatchEvent(new Event("input"));
            textEl.focus();
          }
          close(); toast("已插入续写");
        } catch (err) {
          const msg = String(err && err.message || err);
          if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
            alert("请求被浏览器拦截。\n\n这通常是服务商不支持浏览器 CORS。请换支持 CORS 的接口，或使用 Windows 桌面版。\n\n原始错误：" + msg);
          } else {
            alert("AI 请求失败：" + msg);
          }
          btn.disabled = false; btn.textContent = "生成";
        }
      });
    });
  }

  function bindGlobal() {
    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-action]");
      if (!a) return;
      const action = a.dataset.action;
      if (action === "new") newProjectModal();
      if (action === "import") els.file.click();
      if (action === "back") { state.currentId = ""; state.currentChapterId = ""; location.hash = ""; renderSidebar(); renderView(); }
      if (action === "delete-project") {
        const p = currentProject(); if (!p) return;
        if (confirm(`删除网页版中的《${p.title}》？\n不会影响桌面版文件。`)) {
          store.del(p.id).then(() => {
            state.projects = state.projects.filter((x) => x.id !== p.id);
            state.currentId = ""; state.currentChapterId = ""; location.hash = "";
            renderSidebar(); renderView(); toast("已删除");
          });
        }
      }
      if (action === "export") exportModal();
      if (action === "ai") aiModal("generate");
      if (action === "ai-settings") aiModal("settings");
      if (action === "add-volume") { const p = currentProject(); if (p) addVolume(p); }
    });
    els.file.addEventListener("change", () => {
      const f = els.file.files && els.file.files[0];
      els.file.value = "";
      if (f) importFile(f).catch((e) => toast("导入失败：" + e.message));
    });
    window.addEventListener("hashchange", () => {
      const m = location.hash.match(/^#\/p\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (id !== state.currentId) {
          state.currentId = id;
          const p = currentProject();
          const first = p ? (p.volumes || []).flatMap((v) => v.chapters || [])[0] : null;
          state.currentChapterId = first ? first.id : "";
          renderSidebar(); renderView();
        }
      }
    });
    window.addEventListener("beforeunload", () => { clearTimeout(state.saveTimer); });
  }

  async function init() {
    try {
      db = await openDB();
      state.projects = (await store.all()) || [];
      const m = location.hash.match(/^#\/p\/(.+)$/);
      if (m) {
        state.currentId = decodeURIComponent(m[1]);
        const p = currentProject();
        const first = p ? (p.volumes || []).flatMap((v) => v.chapters || [])[0] : null;
        state.currentChapterId = first ? first.id : "";
      }
      bindGlobal();
      renderSidebar();
      renderView();
    } catch (e) {
      els.view.innerHTML = `<div class="welcome"><h2>浏览器存储不可用</h2><p>${esc(e.message)}。请关闭无痕模式，或换 Edge / Chrome 再试。</p></div>`;
    }
  }
  init();
})();
