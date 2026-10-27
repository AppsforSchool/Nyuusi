"use strict";

/* ===== 設定 ===== */
const CONFIG = {
  owner: "appsforschool",
  repo: "Nyuusi",
  folder: "gifu",
  branch: null,            // null = GitHub APIから既定ブランチを自動取得。固定したい場合は "main" 等を指定
  zipName: "gifu-pdfs.zip",
  keepRootFolder: false,   // true: ZIP内を "gifu/..." にする / false: gifuフォルダ内の相対パスにする
  concurrency: 4           // 同時ダウンロード数
};

/* 絞り込み用の定義（ファイル名に含まれる文字列） */
const SUBJECTS = [["kokugo", "国語"], ["suugaku", "数学"], ["rika", "理科"], ["eigo", "英語"], ["syakai", "社会"]];
const YEARS = [["R8", 2026], ["R7", 2025], ["R6", 2024], ["R5", 2023], ["R4", 2022], ["R3", 2021], ["R2", 2020],
  ["H31", 2019], ["H30", 2018], ["H29", 2017], ["H28", 2016], ["H27", 2015], ["H26", 2014]];

const API = "https://api.github.com";
const $ = (id) => document.getElementById(id);
const el = {
  target: $("target"), status: $("status"), count: $("count"), total: $("total"),
  list: $("list"), download: $("download"), reload: $("reload"),
  pw: $("progress-wrap"), progress: $("progress"), ptext: $("progress-text"),
  link: $("repo-link"), subject: $("subject"), year: $("year")
};

let files = [];      // { path, size }
let branch = null;
let busy = false;

/* ===== 表示ユーティリティ ===== */
function setStatus(msg, type) {
  el.status.textContent = msg;
  el.status.className = "status " + (type || "info");
}
function setProgress(done, total, label) {
  el.pw.hidden = false;
  el.progress.max = total || 1;
  el.progress.value = done;
  el.ptext.textContent = label || (done + " / " + total);
}
function hideProgress() { el.pw.hidden = true; }
function setBusy(b) {
  busy = b;
  el.download.disabled = b || getFiltered().length === 0;
  el.reload.disabled = b;
  el.subject.disabled = b;
  el.year.disabled = b;
}

/* ===== 絞り込み ===== */
function baseName(path) { return path.slice(path.lastIndexOf("/") + 1); }
function fileSubject(path) {
  const n = baseName(path).toLowerCase();
  const hit = SUBJECTS.find(([k]) => n.includes(k));
  return hit ? hit[0] : null;
}
function fileYear(path) {
  const tokens = baseName(path).toUpperCase().match(/[RH]\d+/g) || [];
  const hit = tokens.find((t) => YEARS.some(([k]) => k === t));
  return hit || null;
}
function getFiltered() {
  const sub = el.subject.value, yr = el.year.value;
  return files.filter((f) => (!sub || fileSubject(f.path) === sub) && (!yr || fileYear(f.path) === yr));
}
function initFilters() {
  for (const [k, label] of SUBJECTS) el.subject.add(new Option(label + "（" + k + "）", k));
  for (const [k, y] of YEARS) el.year.add(new Option(k + "（" + y + "）年度", k));
}
function zipFileName() {
  const parts = [el.year.value, el.subject.value].filter(Boolean);
  return parts.length ? CONFIG.zipName.replace(/\.zip$/, "") + "_" + parts.join("_") + ".zip" : CONFIG.zipName;
}
function onFilterChange() {
  renderList();
  if (files.length === 0) return;
  const n = getFiltered().length;
  if (n === 0) setStatus("選択した条件に一致するPDFがありません。", "warn");
  else setStatus("PDFを " + n + " 件表示しています（全 " + files.length + " 件中）。", "ok");
}
function formatSize(n) {
  if (n == null) return "-";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function encodePath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

class AppError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/* ===== GitHub API ===== */
async function ghFetch(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  } catch (e) {
    throw new AppError("GitHub APIに接続できませんでした。ネットワーク接続を確認してください。", "network");
  }
  if (res.ok) return res.json();

  const remaining = res.headers.get("x-ratelimit-remaining");
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const reset = res.headers.get("x-ratelimit-reset");
    const t = reset ? new Date(Number(reset) * 1000).toLocaleTimeString("ja-JP") : "しばらく後";
    throw new AppError("GitHub APIの利用制限に達しました。" + t + "以降に再読み込みしてください。", "rate");
  }
  if (res.status === 404) {
    throw new AppError("リポジトリまたはブランチが見つかりません（HTTP 404）。リポジトリ名・ブランチ名・公開設定を確認してください。", "config");
  }
  if (res.status === 409) {
    throw new AppError("リポジトリが空のため、ファイル一覧を取得できません（HTTP 409）。", "empty-repo");
  }
  throw new AppError("GitHub APIがエラーを返しました（HTTP " + res.status + "）。", "http");
}

async function resolveBranch() {
  if (CONFIG.branch) return CONFIG.branch;
  const info = await ghFetch(API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo);
  if (!info.default_branch) throw new AppError("既定ブランチを特定できませんでした。CONFIG.branch に明示してください。", "config");
  return info.default_branch;
}

function isTargetPdf(path) {
  return path.startsWith(CONFIG.folder + "/") && /\.pdf$/i.test(path);
}

/* Git Trees API（再帰） */
async function listViaTrees(br) {
  const url = API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/trees/" + encodeURIComponent(br) + "?recursive=1";
  const data = await ghFetch(url);
  if (data.truncated) return null; // 結果が省略された → 代替方式へ
  return data.tree.filter((t) => t.type === "blob" && isTargetPdf(t.path)).map((t) => ({ path: t.path, size: t.size }));
}

/* Contents API（ディレクトリを再帰的にたどる） */
async function listViaContents(br, dir, out) {
  const url = API + "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encodePath(dir) + "?ref=" + encodeURIComponent(br);
  const items = await ghFetch(url);
  if (!Array.isArray(items)) throw new AppError("フォルダ「" + dir + "」の内容を取得できませんでした。", "http");
  for (const it of items) {
    if (it.type === "dir") await listViaContents(br, it.path, out);
    else if (it.type === "file" && isTargetPdf(it.path)) out.push({ path: it.path, size: it.size });
  }
  return out;
}

/* ===== 一覧取得・描画 ===== */
function renderList(failedPaths) {
  el.list.textContent = "";
  const failed = new Set(failedPaths || []);
  const shown = getFiltered();
  for (const f of shown) {
    const li = document.createElement("li");
    if (failed.has(f.path)) li.className = "failed";
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = f.path;
    const s = document.createElement("span");
    s.className = "size";
    s.textContent = formatSize(f.size);
    li.append(n, s);
    el.list.appendChild(li);
  }
  el.count.textContent = shown.length === files.length ? String(files.length) : shown.length + " / " + files.length;
  const sum = shown.reduce((a, f) => a + (f.size || 0), 0);
  el.total.textContent = shown.length ? "（合計 " + formatSize(sum) + "）" : "";
  el.download.textContent = shown.length && shown.length !== files.length
    ? "絞り込み結果をZIPでダウンロード（" + shown.length + "件）" : "ZIPをダウンロード";
  el.download.disabled = busy || shown.length === 0;
}

async function loadList() {
  if (busy) return;
  setBusy(true);
  files = [];
  renderList();
  el.count.textContent = "-";
  hideProgress();
  setStatus("PDF一覧を取得しています…", "info");
  try {
    branch = await resolveBranch();
    let result = await listViaTrees(branch);
    if (result === null) {
      setStatus("ファイル数が多いため、別の方式で一覧を取得しています…", "info");
      result = await listViaContents(branch, CONFIG.folder, []);
    }
    files = result.sort((a, b) => a.path.localeCompare(b.path, "ja"));
    renderList();
    if (files.length === 0) {
      setStatus("「" + CONFIG.folder + "」フォルダにPDFが見つかりませんでした（ブランチ: " + branch + "）。", "warn");
    } else {
      setStatus("PDFを " + files.length + " 件取得しました（ブランチ: " + branch + "）。", "ok");
    }
  } catch (e) {
    files = [];
    renderList();
    const type = e.kind === "rate" || e.kind === "empty-repo" ? "warn" : "error";
    setStatus(e instanceof AppError ? e.message : "予期しないエラー: " + e.message, type);
  } finally {
    setBusy(false);
  }
}

/* ===== ダウンロード・ZIP生成 ===== */
async function fetchPdf(path) {
  const url = "https://raw.githubusercontent.com/" + CONFIG.owner + "/" + CONFIG.repo + "/" +
    encodeURIComponent(branch) + "/" + encodePath(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = await res.arrayBuffer();
  // PDFのシグネチャ確認（エラーページやGit LFSポインタを格納しない）
  const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)));
  if (!head.includes("%PDF-")) throw new Error("PDF形式ではない応答");
  return buf;
}

async function downloadZip() {
  const targets = getFiltered();
  if (busy || targets.length === 0) return;
  if (typeof JSZip === "undefined") {
    setStatus("ZIPライブラリ(JSZip)を読み込めませんでした。ネットワークを確認してページを再読み込みしてください。", "error");
    return;
  }
  setBusy(true);
  const zip = new JSZip();
  const failed = [];
  let done = 0, next = 0;
  setStatus("PDFを取得しています…", "info");
  setProgress(0, targets.length);

  async function worker() {
    while (next < targets.length) {
      const f = targets[next++];
      try {
        const buf = await fetchPdf(f.path);
        const name = CONFIG.keepRootFolder ? f.path : f.path.slice(CONFIG.folder.length + 1);
        zip.file(name, buf, { binary: true });
      } catch (e) {
        failed.push({ path: f.path, reason: e.message });
      }
      done++;
      setProgress(done, targets.length);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, targets.length) }, worker));

    const okCount = targets.length - failed.length;
    if (okCount === 0) {
      renderList(failed.map((f) => f.path));
      setStatus("すべてのPDFの取得に失敗しました。ネットワーク接続やリポジトリ設定を確認してください。ZIPは作成していません。", "error");
      hideProgress();
      return;
    }
    if (failed.length > 0) {
      renderList(failed.map((f) => f.path));
      const sample = failed.slice(0, 5).map((f) => "・" + f.path + "（" + f.reason + "）").join("\n");
      const more = failed.length > 5 ? "\n…ほか " + (failed.length - 5) + " 件" : "";
      const go = window.confirm(
        failed.length + " 件のPDFを取得できませんでした。\n\n" + sample + more +
        "\n\n取得できた " + okCount + " 件だけでZIPを作成しますか？\n（キャンセルするとZIPは作成しません）"
      );
      if (!go) {
        setStatus("ZIPの作成をキャンセルしました（取得失敗: " + failed.length + " 件）。", "warn");
        hideProgress();
        return;
      }
    }

    setStatus("ZIPを生成しています…", "info");
    setProgress(0, 100, "0%");
    const blob = await zip.generateAsync(
      { type: "blob", compression: "STORE" }, // PDFは圧縮済みのため無圧縮で高速化
      (m) => setProgress(Math.round(m.percent), 100, Math.round(m.percent) + "%")
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = zipFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    hideProgress();
    if (failed.length > 0) {
      setStatus("ZIPをダウンロードしました（" + okCount + " 件）。取得に失敗した " + failed.length + " 件は含まれていません。", "warn");
    } else {
      setStatus("ZIPをダウンロードしました（" + okCount + " 件、" + formatSize(blob.size) + "）。", "ok");
    }
  } catch (e) {
    hideProgress();
    setStatus("ZIPの生成に失敗しました: " + e.message + "\n（ファイルが大きすぎてメモリ不足になった可能性があります）", "error");
  } finally {
    setBusy(false);
  }
}

/* ===== 初期化 ===== */
el.target.textContent = CONFIG.owner + "/" + CONFIG.repo + " の " + CONFIG.folder + "/ フォルダ";
el.link.href = "https://github.com/" + CONFIG.owner + "/" + CONFIG.repo;
el.download.addEventListener("click", downloadZip);
el.reload.addEventListener("click", loadList);
el.subject.addEventListener("change", onFilterChange);
el.year.addEventListener("change", onFilterChange);
initFilters();
loadList();
