(() => {
  // SPEC.md section 7: catalog.json is injected by the build. Defaults to empty so that
  // opening the template standalone displays a blank table instead of throwing.
  var DATA = window.__KAMIYOBI_DATA__ || null;
  if (!DATA) {
    DATA = { generated_at: "", sources: [], categories: {}, conferences: [] };
  }

  var DAY = 86400000;
  var PAGE = 40;
  var selectedIndex = -1;
  var sortKey = "rem";
  var sortAsc = true;

  var KIND_LABEL = {
    abstract: "概要締切",
    paper: "論文締切",
    journal: "常時受付"
  };

  // recommender.js から供給（テスト可能な単一正典）。無ければこの場で縮退定義。
  var Recommender = (typeof window !== "undefined" && window.Recommender) || null;
  var activeData = DATA;
  var recommendationData = null;
  var recommendationPromise = null;
  var recommendationError = false;
  var historyStatus = "idle";

  function createHistoryLoader(fetchJson, onState) {
    var requestId = 0;
    var pending = null;
    var value = null;
    var status = "idle";

    function notify() {
      if (onState) onState(status);
    }

    return {
      get data() { return value; },
      get status() { return status; },
      cancel: function() {
        requestId += 1;
        pending = null;
        if (status === "loading") {
          status = "idle";
        }
      },
      load: function(ref) {
        if (value) return Promise.resolve(value);
        if (pending) return pending;
        var id = ++requestId;
        status = "loading";
        notify();
        var next = Promise.resolve().then(() => fetchJson(ref)).then((data) => {
          if (id !== requestId) return null;
          if (!data || typeof data !== "object" || !Array.isArray(data.conferences) ||
              data.conferences.some((conf) => !conf || typeof conf !== "object" || !Array.isArray(conf.editions))) {
            throw new Error("invalid history data");
          }
          value = data;
          pending = null;
          status = "ready";
          notify();
          return data;
        }).catch(() => {
          if (id !== requestId) return null;
          pending = null;
          status = "error";
          notify();
          return null;
        });
        pending = next;
        return next;
      }
    };
  }

  // R12: 会議名 + 代表採択論文語彙の IDF 重みを実行時に計算して有効化する。
  // 実測（golden EN）: 実論文タイトルで正解会議 top1 が 25.0→37.5% に改善。
  // 汎用語（machine/deep/cache 等）が全会議の語彙に現れて誤爆するのを減衰する。
  function setRecommendationProfile(data) {
    activeData = data;
    rows = buildRows(data);
    if (Recommender && Recommender.buildNameIdf && data.conferences.length) {
      Recommender.setNameIdf(Recommender.buildNameIdf(data.conferences));
    }
  }

  var state = {
    mode: "deadlines", q: "", cats: [], kind: "", rank: "", win: "all",
    est: false, domestic: false, past: false
  };

  /**
   * @param {string} id
   * @returns {SiteElement}
   */
  function $(id) { return /** @type {SiteElement} */ (document.getElementById(id)); }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function fmtDate(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " +
      pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  }

  function fmtJst(d) {
    var jst = new Date(d.getTime() + 9 * 3600000);
    return jst.getUTCFullYear() + "-" + pad(jst.getUTCMonth() + 1) + "-" + pad(jst.getUTCDate()) + " " +
      pad(jst.getUTCHours()) + ":" + pad(jst.getUTCMinutes()) + " JST";
  }

  // Anywhere on Earth (UTC-12)。SPEC §7: 締切表示に AoE 表記を併記する。
  function fmtAoE(d) {
    var aoe = new Date(d.getTime() - 12 * 3600000);
    return aoe.getUTCFullYear() + "-" + pad(aoe.getUTCMonth() + 1) + "-" + pad(aoe.getUTCDate()) + " " +
      pad(aoe.getUTCHours()) + ":" + pad(aoe.getUTCMinutes()) + " AoE";
  }

  function catLabel(key) {
    return (DATA.categories && DATA.categories[key]) ? key.toUpperCase() : key;
  }

  // タイトル + 開催年。タイトルが既にその年で終わっていれば年を二重に付けない (#93, #294)。
  function titleWithYear(title, year) {
    var t = String(title || "").trim();
    if (!t) return "";
    if (!year) return t;
    var yStr = String(year);
    var yy = yStr.slice(-2);
    var normT = t.normalize ? t.normalize("NFKC").trim() : t;
    var hasYear =
      normT.endsWith(yStr) ||
      normT.endsWith("'" + yy) ||
      (yy && new RegExp("(?:20" + yy + "|['’]?" + yy + ")$").test(normT));
    if (hasYear) {
      return t;
    }
    return t + " " + year;
  }

  // Quick Presets
  function updatePresetActive() {
    var p7d = state.win === "7d" && !state.q && !state.cats.length && !state.kind && !state.rank && !state.est && !state.domestic && !state.past;
    var paStar = state.rank === "A*" && !state.q && !state.cats.length && !state.kind && state.win === "all" && !state.est && !state.domestic && !state.past;
    var pHpcSys = state.cats.length === 2 && state.cats.indexOf("hpc") >= 0 && state.cats.indexOf("systems") >= 0 && !state.q && !state.kind && !state.rank && state.win === "all" && !state.est && !state.domestic && !state.past;
    var pDom = state.domestic && !state.q && !state.cats.length && !state.kind && !state.rank && state.win === "all" && !state.est && !state.past;
    var map = { '7d': p7d, 'a_star': paStar, 'hpc_sys': pHpcSys, 'domestic': pDom };
    Array.prototype.forEach.call(document.querySelectorAll(".preset-btn"), (btn) => {
      var p = btn.getAttribute("data-preset");
      btn.classList.toggle("active", !!map[p]);
    });
  }

  window.applyPreset = (type) => {
    state = { mode: state.mode, q: "", cats: [], kind: "", rank: "", win: "all", est: false, domestic: false, past: false };
    if (type === '7d') state.win = "7d";
    if (type === 'a_star') state.rank = "A*";
    if (type === 'hpc_sys') state.cats = ["hpc", "systems"];
    if (type === 'domestic') state.domestic = true;
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    toForm();
    writeUrl();
    render();
  };

  // Column Sorting
  // 現在の並び順を aria-sort でスクリーンリーダーに伝える（昇順/降順/指定なし）。
  function setSortAria(key) {
    Array.prototype.forEach.call(document.querySelectorAll("th[data-sort]"), (th) => {
      var k = th.getAttribute("data-sort");
      var state = "none";
      if (k === key) {
        state = sortAsc ? "ascending" : "descending";
      }
      th.setAttribute("aria-sort", state);
    });
  }

  window.toggleSort = (key) => {
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
    setSortAria(key);
    render();
  };

  // ソート可能ヘッダーはキーボード（Enter / Space）でも操作できるようにする。
  // グローバル keydown の Enter=選択行のリンクを開く に奪われないよう stopPropagation する。
  Array.prototype.forEach.call(document.querySelectorAll("th[data-sort]"), (th) => {
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        window.toggleSort(th.getAttribute("data-sort"));
      }
    });
  });

  // Drawer Controls
  function openDrawer(r) {
    // フォーカス管理: 開く直前の要素を保存し、ドロワー内（閉じるボタン）へフォーカスを移す（#218）。
    window._prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    $("drawerBackdrop").classList.add("active");
    $("drawerTitle").textContent = titleWithYear(r.conf.title || r.conf.key, r.ed.year);
    $("drawerFullName").textContent = r.conf.full_name || "";

    var html = '<div style="background: var(--chip); padding: 14px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 16px;">' +
      '<div style="font-size: 0.78rem; color: var(--muted);">種別・日時</div>' +
      '<div style="font-size: 1.1rem; font-weight: 600; color: var(--fg); margin-top: 2px;">' + esc(KIND_LABEL[r.kind] || r.kind) + '</div>' +
      (r.kind === "journal"
        ? '<div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); margin-top: 4px;">随時受付（締切なし）</div>'
        : '<div style="font-family: var(--font-mono); font-size: 0.85rem; color: var(--accent); margin-top: 4px;">' + fmtDate(new Date(r.t)) + ' UTC (' + fmtJst(new Date(r.t)) + ' / ' + fmtAoE(new Date(r.t)) + ')</div>') +
      '</div>';

    var actionRow = '';
    if (r.kind === "journal") {
      actionRow = '<div style="font-size: 0.85rem; color: var(--muted); margin-bottom: 16px;">常時受付のジャーナル（締切なし）です。投稿規程を公式サイトで確認してください。</div>';
    } else {
      actionRow = '<div style="font-size: 0.85rem; color: var(--muted); margin-bottom: 16px;">投稿前に公式サイトで最新の募集要項と締切を確認してください。</div>';
    }
    html += actionRow;

    var officialLink = safeExternalUrl(r.ed.link || r.conf.link);
    if (officialLink) {
      html += '<a href="' + esc(officialLink) + '" target="_blank" style="display: block; text-align: center; background: var(--accent); color: #fff; text-decoration: none; padding: 10px; border-radius: 6px; font-weight: 600; margin-bottom: 20px;">公式サイトを開く</a>';
    }

    html += '<div style="font-size: 0.85rem;">' +
      '<p style="margin-bottom: 8px;"><strong>開催地:</strong> ' + esc(r.ed.place || "未定") + '</p>' +
      '<p style="margin-bottom: 8px;"><strong>会期:</strong> ' + esc(r.ed.date_text || r.ed.event_start || "未定") + '</p>' +
      '</div>';

    window._activeRef = r;
    $("drawerBody").innerHTML = html;
    var closeBtn = $("drawerClose");
    if (closeBtn) closeBtn.focus();
  }
  window.openDrawer = openDrawer;

  // 閉じるのは ✕ ボタン（自前 onclick 経由、引数なし）とバックドロップの直接クリックのみ。
  // ドロワー内の button がバブルしても閉じない（#207）。
  function closeDrawer(e) {
    if (!e || e.target === $("drawerBackdrop")) {
      $("drawerBackdrop").classList.remove("active");
      // フォーカスを開く直前の要素へ戻す（#218）。
      var prev = window._prevFocus;
      window._prevFocus = null;
      if (prev && prev.focus) prev.focus();
    }
  }
  window.closeDrawer = closeDrawer;

  // Keyboard Navigation (j/k/Enter/Esc//)
  function onKeydown(e) {
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" ||
        tag === "BUTTON" || e.target.isContentEditable) {
      if (e.key === "Escape") { e.target.blur(); }
      return;
    }
    // 推薦モードでは非表示の締切表用ショートカットを無効化する。
    if (typeof state !== "undefined" && state.mode === "recommend" &&
        (e.key === "d" || e.key === "j" || e.key === "k" || e.key === "Enter" ||
         e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      $("q").focus();
    } else if (e.key === "d" && selectedIndex >= 0 && selectedIndex < shown.length) {
      // キーボードで詳細ドロワーを開く（#218）。行にフォーカスしてから開き、
      // openDrawer が _prevFocus として保存する。
      e.preventDefault();
      var dtrs = Array.prototype.filter.call($("tbody").querySelectorAll("tr"), (t) => !t.classList.contains("detail-row"));
      if (dtrs[selectedIndex]) dtrs[selectedIndex].focus();
      openDrawer(shown[selectedIndex]);
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      if (selectedIndex < shown.length - 1) {
        selectedIndex++;
        updateRowSelection();
      }
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        updateRowSelection();
      }
    } else if (e.key === "Enter" && selectedIndex >= 0 && selectedIndex < shown.length) {
      var r = shown[selectedIndex];
      var href = safeExternalUrl(r.ed.link || r.conf.link);
      if (href) window.open(href, "_blank");
    } else if (e.key === "Escape") {
      closeDrawer();
    }
  }
  window.addEventListener("keydown", onKeydown);

  function updateRowSelection() {
    // 展開用 detail-row を除外し、shown[] の行と 1:1 対応を保つ
    var trs = Array.prototype.filter.call($("tbody").querySelectorAll("tr"), (t) => !t.classList.contains("detail-row"));
    Array.prototype.forEach.call(trs, (tr, idx) => {
      tr.classList.toggle("selected", idx === selectedIndex);
    });
    if (trs[selectedIndex]) {
      trs[selectedIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ---- CATEGORIES ----
  var catsBox = $("cats");
  Object.keys(DATA.categories || {}).forEach((k) => {
    var lbl = document.createElement("label");
    var chk = document.createElement("input");
    chk.type = "checkbox"; chk.value = k;
    lbl.appendChild(chk);
    var span = document.createElement("span");
    span.textContent = k.toUpperCase() + " (" + DATA.categories[k] + ")";
    lbl.appendChild(span);
    catsBox.appendChild(lbl);
  });

  // ---- SELECTS ----
  var kindSel = $("kind");
  var optAllK = document.createElement("option");
  optAllK.value = ""; optAllK.textContent = "投稿締切（概要・論文）";
  kindSel.appendChild(optAllK);
  Object.keys(KIND_LABEL).forEach((k) => {
    var opt = document.createElement("option");
    opt.value = k; opt.textContent = KIND_LABEL[k];
    kindSel.appendChild(opt);
  });

  var rankSel = $("rank");
  var optAllR = document.createElement("option");
  optAllR.value = ""; optAllR.textContent = "すべて";
  rankSel.appendChild(optAllR);
  ["A*", "A", "B", "C", "N"].forEach((r) => {
    var opt = document.createElement("option");
    opt.value = r; opt.textContent = "Rank " + r;
    rankSel.appendChild(opt);
  });

  // ---- DATA FLATTENING ----
  function buildRows(data) {
    var out = [];
    (data.conferences || []).forEach((conf) => {
    (conf.editions || []).forEach((e) => {
      var pairs = [];
      if (conf.rank) {
        Object.keys(conf.rank).forEach((rk) => {
          if (conf.rank[rk]) { pairs.push(rk + ":" + conf.rank[rk]); }
        });
      }
      var baseHay = [
        conf.title, conf.full_name, conf.key, e.place, e.date_text
      ].filter(Boolean).join(" ").toLowerCase();

      (e.deadlines || []).forEach((dl) => {
        var t = Date.parse(dl.utc);
        if (isNaN(t)) return;
        out.push({
          conf: conf, ed: e, dl: dl,
          kind: dl.kind, est: e.estimated,
          t: t, tLast: t,
          cats: conf.categories || [],
          tags: conf.tags || [],
          rankPairs: pairs,
          hay: baseHay + " " + (dl.label || "") + " " + dl.kind,
          dupLabel: dl.comment || ""
        });
      });
    });
    });
    return out;
  }
  var rows = buildRows(DATA);

  function setDeadlineProfile(data) {
    activeData = data;
    rows = buildRows(data);
  }

  function syncHistoryState() {
    historyStatus = historyLoader.status;
    if (historyStatus === "ready" && historyLoader.data && state.mode === "deadlines" && state.past) {
      setDeadlineProfile(historyLoader.data);
    } else if (historyStatus === "error" && state.mode === "deadlines") {
      setDeadlineProfile(DATA);
    }
    render();
  }

  function fetchHistoryJson(ref) {
    return fetch(ref).then((response) => {
      if (!response.ok) throw new Error("history " + response.status);
      return response.json();
    });
  }

  var historyLoader = createHistoryLoader(fetchHistoryJson, syncHistoryState);

  // Update Summary Dashboard Stats
  $("statConfs").textContent = String((DATA.conferences || []).length);
  var nowMs = Date.now();
  var next30 = rows.filter((r) => (r.kind === "abstract" || r.kind === "paper") && !r.est && r.t >= nowMs && (r.t - nowMs) <= 30*DAY).length;
  $("statUpcoming").textContent = String(next30);
  var nicheCount = (DATA.conferences || []).filter((c) => (c.tags || []).indexOf("niche") !== -1).length;
  $("statNiche").textContent = String(nicheCount);
  var domCount = (DATA.conferences || []).filter((c) => (c.tags || []).indexOf("domestic-jp") !== -1).length;
  $("statDomestic").textContent = String(domCount);

  // ---- REMAIN / STATUS ----
  function remain(ms) {
    var diff = ms - Date.now();
    if (diff < 0) {
      var pd = Math.floor(-diff / DAY);
      return { text: pd === 0 ? "本日終了" : pd + " 日前に終了", cls: "past" };
    }
    var d = Math.floor(diff / DAY);
    if (d === 0) {
      var h = Math.floor(diff / 3600000);
      return { text: h <= 0 ? "まもなく" : "あと " + h + " 時間", cls: "today" };
    }
    return { text: "あと " + d + " 日", cls: d <= 14 ? "soon" : "" };
  }

  // Paper Text Matching Score — ロジックは recommender.js (Recommender.breakdown) に移管

  // ---- SEMANTIC MATCH (AI 補助: transformers.js + embeddings.json) ----
  // embeddings.json は build 時に生成（src/embeddings.ts）。
  // ブラウザでは transformers.js でユーザー入力を埋め込み、語彙スコアと合成する。
  var EMBEDDINGS = null;       // manifest + 言語別の埋め込み表
  var semQuery = null;         // 現在のユーザー入力の埋め込みベクトル
  var semModel = null;         // transformers.js の pipeline
  var semLoadedModel = "";    // ロード済みモデル ID（言語適応で切り替え）
  var semEmbeddings = null;   // 言語に応じた埋め込み表（en / multi）
  var semGeneration = 0;
  var semState = "idle";       // idle | loading | ready | error（AI 状態の表示用）
  var semProbeCache = {};       // model@revision -> probe compatibility
  var semLastText = "";       // 最後に埋め込み計算したテキスト（再計算判定用）
  var lastIsJp = false;        // 直近の論文テキストが日本語か（合成比・閾値の表示用）
  var lastLen = 0;             // 直近の論文テキストの内容語数（英語の合成比の適応用）

  function currentPaperText() {
    var pe = $("paperText");
    return pe ? pe.value : "";
  }

  function semanticIsCurrent(generation, text) {
    return generation === semGeneration && currentPaperText() === text;
  }

  function clearSemantic(nextState) {
    semQuery = null;
    semEmbeddings = null;
    semLastText = "";
    if (Recommender && Recommender.setPaperVecs) Recommender.setPaperVecs(null);
    if (nextState) semState = nextState;
  }

  function invalidateSemantic() {
    semGeneration += 1;
    clearSemantic("idle");
  }

  function loadEmbeddings(cb) {
    if (EMBEDDINGS) { cb(); return; }
    fetch("embeddings.json")
      .then((r) => { if (!r.ok) throw new Error("embeddings.json " + r.status); return r.json(); })
      .then((d) => { EMBEDDINGS = d; cb(); })
      .catch(() => { cb(); }); // 無ければ語彙スコアのみで動作
  }

  function loadTransformers(modelMeta, generation, cb) {
    var modelId = modelMeta.model;
    var revision = modelMeta.revision;
    var modelKey = modelId + "@" + revision;
    if (semLoadedModel === modelKey && semModel) {
      if (generation === semGeneration) cb(true);
      return;
    }
    if (generation !== semGeneration) return;
    if (semState === "error") { cb(false); return; }
    semState = "loading";
    // jsdelivr の素のパッケージ URL は Node 向けバンドルで window.transformers を
    // 公開しない（実行しても undefined になる）。ESM ビルド（+esm）を動的 import する。
    var transformersUrl = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm";
    import(transformersUrl)
      .then((m) => m.pipeline("feature-extraction", modelId, { revision: revision }))
      .then((mdl) => {
        if (generation !== semGeneration) return;
        semModel = mdl;
        semLoadedModel = modelKey;
        semState = "ready";
        cb(true);
      })
      .catch(() => {
        if (generation !== semGeneration) return;
        semState = "error";
        cb(false);
      });
  }

  function checkSemanticProbe(modelMeta, cb) {
    var modelKey = modelMeta.model + "@" + modelMeta.revision;
    if (Object.prototype.hasOwnProperty.call(semProbeCache, modelKey)) {
      cb(semProbeCache[modelKey]);
      return;
    }
    semModel(modelMeta.probe.text, { pooling: "mean", normalize: true })
      .then((out) => {
        var ok = Recommender.embeddingProbeMatches(modelMeta, Array.from(out.data));
        semProbeCache[modelKey] = ok;
        cb(ok);
      })
      .catch(() => { semProbeCache[modelKey] = false; cb(false); });
  }

  // 論文テキストが変わったら埋め込みを再計算し、完了後に render する。
  // 言語適応: 日本語を含む論文は多言語モデル、それ以外は英語モデルで埋め込む
  // （実測: EN は英語モデル 80.1% > 多言語 76.2%、JP は多言語 42.9% > 英語 19.0%）。
  function scheduleSemantic() {
    var generation = ++semGeneration;
    var text = currentPaperText();
    clearSemantic("idle");
    if (!text.trim() || !Recommender) return;
    semState = "loading";
    loadEmbeddings(() => {
      if (!semanticIsCurrent(generation, text)) return;
      if (!EMBEDDINGS) {
        clearSemantic("error");
        render();
        return;
      }
      var isJp = Recommender.hasJapanese(text);
      var language = isJp && EMBEDDINGS.multi ? "multi" : "en";
      var embSet = language === "multi" ? EMBEDDINGS.multi : EMBEDDINGS;
      if (!Recommender.embeddingSetCompatible(EMBEDDINGS, language)) {
        clearSemantic("error");
        render();
        return;
      }
      var modelMeta = EMBEDDINGS.manifest.models[language];
      loadTransformers(modelMeta, generation, (loaded) => {
        if (!semanticIsCurrent(generation, text)) return;
        if (!loaded || semLoadedModel !== modelMeta.model + "@" + modelMeta.revision || !semModel) {
          clearSemantic("error");
          render();
          return;
        }
        checkSemanticProbe(modelMeta, (probeOk) => {
          if (!semanticIsCurrent(generation, text)) return;
          if (!probeOk) {
            clearSemantic("error");
            render();
            return;
          }
          var lines = Recommender.parsePaperLines(text);
          var q = Recommender.queryText(lines);
          semModel(q, { pooling: "mean", normalize: true })
          .then((out) => {
            if (!semanticIsCurrent(generation, text)) return;
            var nextQuery = Array.from(out.data);
            // 擬似関連性フィードバック（PRF）: 掲載先タグ付き論文がある場合、
            // その会議の埋め込みを 0.3 混ぜる（「自分が載せた所と似た会議」を拾う）。
            // 実測: タグ付きクエリで正解会議 #1 が 78.9% → 92.2% に改善。
            var tagged = lines.filter((p) => p.venue);
            if (tagged.length && activeData && activeData.conferences) {
              var matched = [];
              tagged.forEach((p) => {
                Recommender.matchVenueTag(p.venue, activeData.conferences).forEach((c) => matched.push(c));
              });
              var mvecs = matched.map((c) => embSet.embeddings[c.key]).filter(Boolean);
              if (mvecs.length) {
                var avg = mvecs[0].slice();
                for (var i = 1; i < mvecs.length; i++) {
                  for (var j = 0; j < avg.length; j++) avg[j] += mvecs[i][j];
                }
                avg = avg.map((x) => x / mvecs.length);
                nextQuery = Recommender.blendVectors(nextQuery, avg, 0.7);
              }
            }
            if (!semanticIsCurrent(generation, text)) return;
            semQuery = nextQuery;
            semEmbeddings = embSet.embeddings;
            // R16: 論文個別ベクトル（max 類似度）は英語クエリのみ。日本語クエリは
            // 多言語モデルなので英語モデルの論文ベクトルを混ぜない（言語別分離設計）。
            Recommender.setPaperVecs(isJp ? null : EMBEDDINGS.paperVecs);
            semLastText = text;
            semState = "ready";
            render();
          })
          .catch(() => {
            if (!semanticIsCurrent(generation, text)) return;
            clearSemantic("error");
            render();
          });
        });
      });
    });
  }

  // ---- FILTERING ----
  function filter() {
    var now = Date.now();
    var q = state.q.toLowerCase();
    var isWinFuture = state.win === "future";
    var limit = (state.win === "all" || isWinFuture) ? Infinity : now + parseInt(state.win, 10) * DAY;
    var pElem = (typeof document !== 'undefined') ? $("paperText") : null;
    var pText = state.mode === "recommend" && pElem ? pElem.value.trim() : "";
    // 単体抽出テスト（node probe）でも動くよう、filter 内では window 経由で解決する
    var Rec = (typeof window !== "undefined" && window.Recommender) || null;
    var pLines = Rec ? Rec.parsePaperLines(pText) : (pText ? [{ title: pText, keywords: "", venue: "" }] : []);
    var isJp = Rec ? Rec.hasJapanese(pText) : false;
    lastIsJp = isJp;
    lastLen = Rec ? Rec.contentWordCount(pText) : 0;

    // 分野: 手動チップがあればそれで絞る。論文モードでチップが空なら絞らない
    // （スコア順ソートで自然に候補が上位に来る。自動判定は表示用に留める）。
    var cats = state.cats;
    var autoCats = (!cats.length && pLines.length && Rec) ? Rec.autoDetectCats(pLines) : [];
    // 掲載先タグの属するカテゴリ（例: RTSS タグ → systems）。同カテゴリの会議を僅かにブースト
    var venueCats = (pLines.length && Rec) ? Rec.venueCategories(pLines, rows) : [];

    // 論文モードおよび常時受付モード: 未来締切 + 常時受付ジャーナル + 未来締切の無い会議の過去代表行
    // （過去行は代表 1 行のみに限定し、全過去版で埋めない）
    var pool = rows;
    if (pLines.length && Rec) {
      pool = rows
        .filter((r) => r.t >= now)
        .concat(Rec.journalRows(activeData.conferences, now), Rec.pastRepresentatives(rows, now));
    } else if (state.kind === "journal" && Rec) {
      pool = rows.concat(Rec.journalRows(activeData.conferences, now));
    }

    // 推薦モード（論文入力あり）では締切画面用の検索/種別/ランク/期間/分野/国内/推定/過去フィルタを
    // 適用しない。pool は既に未来締切+常時受付+過去代表行で構成済み。
    var inRecommend = state.mode === "recommend" && pLines.length > 0;

    var out = pool.filter((r) => {
      if (!inRecommend && !state.est && r.est && !pLines.length) { return false; }
      // 過去行は通常モードで除外（「過去の締切も表示」トグルで表示）。
      // 論文モードでは「締切済みだが次回予定あり」の会議として許容
      if (r.t < now && !pLines.length && !state.past) { return false; }
      if (r.est && r.t < now) { return false; }
      // このサイトは「これから投稿できるところ」を探すもの。
      // 投稿締切（概要・論文）以外の種別（開催・採否通知等）は表示しない。
      // 論文モードまたは種別指定時のみ常時受付ジャーナル（kind: journal）を許容する。
      if (r.kind !== "abstract" && r.kind !== "paper" && !((pLines.length || state.kind === "journal") && r.kind === "journal")) { return false; }
      if (!inRecommend && r.t > limit) { return false; }
      if (!inRecommend && state.kind && r.kind !== state.kind) { return false; }
      // ランクはグレード厳密比較（indexOf の部分一致だと A が core:A* に誤マッチする）
      if (!inRecommend && state.rank) {
        var rankHit = Rec ? Rec.rankMatches(r.rankPairs, state.rank)
          : r.rankPairs.indexOf(state.rank) >= 0;
        if (!rankHit) { return false; }
      }
      if (!inRecommend && cats.length) {
        var hit = false;
        for (var i = 0; i < cats.length; i++) {
          if (r.cats.indexOf(cats[i]) >= 0) { hit = true; break; }
        }
        if (!hit) { return false; }
      }
      if (!inRecommend && state.domestic && (r.tags || []).indexOf("domestic-jp") < 0) { return false; }
      if (!inRecommend && q && r.hay.indexOf(q) < 0) { return false; }

      r._boosted = false;
      return true;
    });

    if (pLines.length && Rec) {
      var semanticScores = null;
      if (semQuery && semEmbeddings) {
        semanticScores = {};
        out.forEach((r) => {
          var key = r.conf && r.conf.key;
          if (key && !Object.prototype.hasOwnProperty.call(semanticScores, key)) {
            semanticScores[key] = Rec.semanticScore(key, semQuery, semEmbeddings);
          }
        });
      }
      out = Rec.venueRecommendations(out, pLines, semanticScores, now, { venueCats: venueCats })
        .filter((recommendation) => recommendation.fit.score >= 10)
        .map((recommendation) => {
          var r = recommendation.row;
          r._boosted = recommendation.boosted;
          r._match = recommendation.match;
          r._vocabScore = recommendation.fit.lexicalScore;
          r._matchScore = recommendation.fit.score;
          r._fitLabel = recommendation.fit.label;
          r._lexicalRank = recommendation.fit.lexicalRank;
          r._semanticRank = recommendation.fit.semanticRank;
          r._semScore = recommendation.fit.semanticScore;
          r._availability = recommendation.availability;
          return r;
        });
    }

    // Custom Sorting
    out.sort((a, b) => {
      if (pLines.length && Rec) {
        return Rec.comparePapers(a, b, now);
      }
      var mult = sortAsc ? 1 : -1;
      if (sortKey === "conf") {
        return (a.conf.title || "").localeCompare(b.conf.title || "") * mult;
      } else if (sortKey === "rank") {
        var ar = a.rankPairs[0] || "";
        var br = b.rankPairs[0] || "";
        return (ar === br ? 0 : ar > br ? 1 : -1) * mult;
      }
      return (a.t - b.t) * mult;
    });

    return out;
  }

  // ---- RENDERING ----
  var shown = [];
  var drawn = 0;

  function td(tr, label, cls) {
    var e = document.createElement("td");
    if (label) { e.setAttribute("data-label", label); }
    if (cls) { e.className = cls; }
    tr.appendChild(e);
    return e;
  }

  function line(parent, text, cls) {
    if (!text) { return null; }
    var d = document.createElement("div");
    if (cls) { d.className = cls; }
    d.textContent = text;
    parent.appendChild(d);
    return d;
  }

  function makeRow(r) {
    var tr = document.createElement("tr");
    tr.tabIndex = -1; // スクリプトからのフォーカス受付（#218: ドロワー開閉時のフォーカス復元先）
    tr.onclick = (e) => {
      var target = /** @type {HTMLElement} */ (e.target);
      if (target.classList && target.classList.contains("match-trigger")) {
        toggleDetail(r, tr);
        return;
      }
      if (target.tagName !== "A") { openDrawer(r); }
    };
    var rem = remain(r.t);
    // 常時受付ジャーナルは締切の概念がないため「本日終了」等の誤解を与えない表示にする
    if (r.kind === "journal") { rem = { text: "常時受付", cls: "" }; }

    var c0 = td(tr, "残り", "c-deadline");
    line(c0, rem.text, "left " + rem.cls);

    var c1 = td(tr, "日時");
    if (r.kind === "journal") {
      line(c1, "随時受付", "nowrap");
    } else {
      var d = new Date(r.t);
      line(c1, fmtDate(d) + " UTC", "nowrap");
      line(c1, fmtJst(d), "sub nowrap");
      line(c1, fmtAoE(d), "sub nowrap");
    }

    var c2 = td(tr, "会議");
    var head = document.createElement("div");
    head.className = "conf";
    var name = titleWithYear(r.conf.title || r.conf.key || "", r.ed.year);
    var href = safeExternalUrl(r.ed.link || r.conf.link);
    if (href) {
      var a = document.createElement("a");
      a.href = href; a.textContent = name.trim();
      a.rel = "noopener noreferrer"; a.target = "_blank";
      head.appendChild(a);
    } else {
      head.textContent = name.trim();
    }
    c2.appendChild(head);
    if (r.conf.full_name && r.conf.full_name !== r.conf.title) {
      line(c2, r.conf.full_name, "sub");
    }
    var tags = document.createElement("div");
    r.cats.forEach((k) => {
      var s = document.createElement("span");
      s.className = "tag"; s.textContent = catLabel(k);
      tags.appendChild(s);
    });
    if (r._matchScore && r._matchScore >= 10) {
      var ms = document.createElement("span");
      // match-trigger: クリックで行内展開（この会議が選ばれた理由の内訳）
      ms.className = "tag match match-trigger"; ms.textContent = "一致評価 " + (r._fitLabel || "評価保留") + " ▾";
      if (r._match && r._match.agg) {
        var agg = r._match.agg;
        var parts = [];
        if (agg.domain > 0) parts.push("分野シグナル +" + agg.domain);
        if ((agg.venueName || 0) > 0) parts.push("会議名一致 +" + agg.venueName);
        if (agg.paper > 0) parts.push("採択論文一致 +" + agg.paper);
        if (agg.jp > 0) parts.push("日本語一致 +" + agg.jp);
        if (agg.tags > 0) parts.push("領域タグ +" + agg.tags);
        if (agg.venue > 0) parts.push("過去掲載先一致");
        if (r._semScore > 0) parts.push("AI類似度 " + r._semScore + "点");
        if (parts.length) ms.title = parts.join(" ／ ");
      }
      tags.appendChild(ms);
    }
    if (r._match && r._match.venueHit) {
      var vh = document.createElement("span");
      vh.className = "tag match"; vh.textContent = "過去掲載先一致";
      tags.appendChild(vh);
    }
    if (r.est) {
      var es = document.createElement("span");
      es.className = "tag est"; es.textContent = "推定";
      tags.appendChild(es);
    }
    if (r.kind === "journal") {
      var jr = document.createElement("span");
      jr.className = "tag match"; jr.textContent = "常時受付";
      tags.appendChild(jr);
    } else if (r.t < Date.now()) {
      var pp = document.createElement("span");
      pp.className = "tag past"; pp.textContent = "締切済み（次回予定）";
      tags.appendChild(pp);
    }
    if ((r.tags || []).indexOf("domestic-jp") >= 0) {
      var dj = document.createElement("span");
      dj.className = "tag"; dj.textContent = "国内";
      tags.appendChild(dj);
    }
    if (tags.childNodes.length) { c2.appendChild(tags); }

    var c3 = td(tr, "種別");
    line(c3, (KIND_LABEL[r.kind] || r.kind) + (r.dupLabel ? ": " + r.dupLabel : ""));
    var detail = [];
    if (r.dl.round && r.dl.round > 1) { detail.push("第 " + r.dl.round + " ラウンド"); }
    if (r.dl.label) { detail.push(r.dl.label); }
    if (detail.length) { line(c3, detail.join(" / "), "sub"); }

    var c4 = td(tr, "ランク");
    if (r.rankPairs.length) {
      r.rankPairs.forEach((p) => {
        var s = p.split(":");
        var e = document.createElement("span");
        e.className = "tag";
        e.textContent = s[0].toUpperCase() + " " + s[1];
        c4.appendChild(e);
      });
    } else {
      line(c4, "-", "sub");
    }

    var c5 = td(tr, "会期");
    var span = "-";
    if (r.ed.event_start) {
      span = r.ed.event_end && r.ed.event_end !== r.ed.event_start
        ? r.ed.event_start + " 〜 " + r.ed.event_end
        : r.ed.event_start;
    }
    line(c5, span, "sub nowrap");

    var c6 = td(tr, "開催地");
    line(c6, r.ed.place || "-", "sub");

    return tr;
  }

  // ---- 推薦理由の行内展開（一致評価タグのクリックで開閉） ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function safeExternalUrl(value) {
    return window.Recommender && window.Recommender.safeExternalUrl
      ? window.Recommender.safeExternalUrl(value)
      : "";
  }

  function makeDetailRow(r) {
    var tr = document.createElement("tr");
    tr.className = "detail-row";
    var td = document.createElement("td");
    td.colSpan = 7;
    var m = r._match || {};
    var agg = m.agg || { domain: 0, name: 0, paper: 0, jp: 0, tags: 0, venue: 0 };
    var lines = [];
    var pe = $("paperText");
    if (pe && pe.value.trim() && Recommender) {
      lines = Recommender.parsePaperLines(pe.value);
    }

    var chips = [];
    if (agg.domain > 0) chips.push(["分野シグナル", "+" + agg.domain, "会議のカテゴリと論文キーワードが一致（HPC/AI/Security 等）"]);
    if ((agg.venueName || 0) > 0) chips.push(["会議名一致", "+" + agg.venueName, "会議名の内容語が論文タイトル・キーワードに含まれる"]);
    if (agg.paper > 0) chips.push(["採択論文一致", "+" + agg.paper, "この会議の代表採択論文の語彙と一致"]);
    if (agg.jp > 0) chips.push(["日本語一致", "+" + agg.jp, "日本語の会議名・論文語が一致"]);
    if (agg.tags > 0) chips.push(["領域タグ", "+" + agg.tags, "会議の領域タグ（real-time 等）が論文に含まれる"]);
    if (agg.venue > 0) chips.push(["過去掲載先一致", "補助", "過去に同じ掲載先が確認された補助シグナル（トピック一致とは別）"]);
    if (r._semScore > 0) chips.push(["semantic 候補", "rank " + (r._semanticRank || "—"), "埋め込み検索の候補順位を RRF に加算"]);
    if (r._boosted) chips.push(["同分野ブースト", "+10", "掲載先タグから推定した分野とこの会議が一致"]);
    if (!chips.length) chips.push(["一致要素なし", "—", "低スコアでも閾値を超えたため表示"]);

    var html = '<div class="detail-inner">';
    html += '<div class="detail-head">一致評価 ' + esc(r._fitLabel || "評価保留") + ' の内訳 — この会議が選ばれた理由</div>';
    var comp;
    if (r._semanticRank) {
      comp = 'RRF: 語彙 rank ' + (r._lexicalRank || '—') + ' + semantic rank ' + r._semanticRank + ' → 一致評価 ' + esc(r._fitLabel || "評価保留");
    } else if (semState === "loading") {
      comp = '語彙スコア ' + r._vocabScore + '点（AI 類似度 計算中…）';
    } else if (semState === "error") {
      comp = '語彙スコア ' + r._vocabScore + '点（オフラインのため AI 類似度なし）';
    } else {
      comp = '語彙スコア ' + r._vocabScore + '点';
    }
    html += '<div class="detail-comp">' + comp + (m.evidence && m.evidence.some(function (e) { return e.rank; }) ? '（rank evidence を RRF 集約）' : '') + '</div>';
    html += '<div class="reason-chips">' + chips.map((c) => '<span class="reason-chip" title="' + esc(c[2]) + '"><b>' + esc(c[0]) + '</b><em>' + esc(c[1]) + '</em></span>').join("") + '</div>';

    if (lines.length > 1) {
      html += '<div class="perline">';
      for (var i = 0; i < lines.length; i++) {
        var p = lines[i];
        var pl = m.perLine && m.perLine[i];
        var sc = pl ? pl.score : 0;
        var parts = [];
        if (pl) {
          if (pl.details.domain > 0) parts.push("分野 +" + pl.details.domain);
          if (pl.details.name > 0) parts.push("会議名 +" + pl.details.name);
          if (pl.details.paper > 0) parts.push("採択論文 +" + pl.details.paper);
          if (pl.details.jp > 0) parts.push("日本語 +" + pl.details.jp);
          if (pl.details.tags > 0) parts.push("タグ +" + pl.details.tags);
          if (pl.details.venue > 0) parts.push("過去掲載先");
        }
        html += '<div class="perline-item">' +
          '<span class="perline-idx">' + (i + 1) + '</span>' +
          '<span class="perline-title">' + esc(p.title || "") + '</span>' +
          '<span class="perline-score">' + sc + '点</span>' +
          (pl && pl.venueHit ? '<span class="perline-venue">過去掲載先一致' + (p.venue ? " (" + esc(p.venue) + ")" : "") + '</span>' : "") +
          (parts.length ? '<span class="perline-parts">' + parts.join(" ・ ") + '</span>' : "") +
          '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    td.innerHTML = html;
    tr.appendChild(td);
    return tr;
  }

  function toggleDetail(r, tr) {
    var next = tr.nextElementSibling;
    if (next && next.classList.contains("detail-row")) {
      next.remove();
      return;
    }
    tr.parentNode.insertBefore(makeDetailRow(r), tr.nextSibling);
  }

  function drawMore() {
    var tbody = $("tbody");
    var frag = document.createDocumentFragment();
    var end = Math.min(drawn + PAGE, shown.length);
    for (var i = drawn; i < end; i++) { frag.appendChild(makeRow(shown[i])); }
    tbody.appendChild(frag);
    drawn = end;
    var btn = $("more");
    if (drawn < shown.length) {
      btn.hidden = false;
      btn.textContent = "さらに表示 (残り " + (shown.length - drawn) + " 件)";
    } else {
      btn.hidden = true;
    }
  }

  function recommendationAvailability(r) {
    var a = r._availability || {};
    if (a.status === "ongoing") return "常時受付";
    if (a.status === "open" && a.timestamp) {
      return "次回締切: " + fmtDate(new Date(a.timestamp)) + " UTC / " + fmtAoE(new Date(a.timestamp)) + (a.estimated ? "（推定）" : "");
    }
    if (a.status === "past") {
      return a.timestamp ? "締切済み" : "締切済み（次回情報なし）";
    }
    return "受付状況不明";
  }

  function makeRecommendationCard(r) {
    var card = document.createElement("article");
    card.className = "recommendation-card";
    var a = r._availability || {};
    var isPastOnly = a.status === "past";
    var title = document.createElement("h3");
    var name = titleWithYear(r.conf.title || r.conf.key || "", isPastOnly ? null : r.ed.year);
    var href = safeExternalUrl(isPastOnly ? r.conf.link : (r.ed.link || r.conf.link));
    if (href) {
      var link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = name;
      title.appendChild(link);
    } else {
      title.textContent = name;
    }
    card.appendChild(title);
    if (r.conf.full_name && r.conf.full_name !== r.conf.title) line(card, r.conf.full_name, "sub");

    var meta = document.createElement("div");
    meta.className = "card-meta";
    var fit = document.createElement("span");
    fit.className = "tag match";
    fit.textContent = "一致評価 " + (r._fitLabel || "評価保留");
    meta.appendChild(fit);
    var availability = document.createElement("span");
    availability.className = "tag";
    availability.textContent = recommendationAvailability(r);
    meta.appendChild(availability);
    card.appendChild(meta);

    var match = r._match || {};
    var agg = match.agg || {};
    var reasons = [];
    [["分野シグナル", agg.domain], ["会議名一致", agg.venueName], ["採択論文一致", agg.paper],
      ["日本語一致", agg.jp], ["領域タグ", agg.tags]]
      .forEach((item) => { if (item[1] > 0) reasons.push(item[0] + " +" + item[1]); });
    if (agg.venue > 0) reasons.push("過去掲載先一致");
    if (r._semanticRank) reasons.push("semantic rank " + r._semanticRank);
    if (r._boosted) reasons.push("同分野ブースト");
    line(card, reasons.length ? "選定理由: " + reasons.join(" / ") : "選定理由: 一致要素を確認できる候補", "card-section");
    if (r.conf.link && safeExternalUrl(r.conf.link)) {
      var official = document.createElement("a");
      official.href = safeExternalUrl(r.conf.link);
      official.target = "_blank";
      official.rel = "noopener noreferrer";
      official.textContent = "公式サイト";
      official.className = "card-section";
      card.appendChild(official);
    }
    return card;
  }

  function renderRecommendationCards(list) {
    var cards = $("recommendationCards");
    cards.textContent = "";
    if (!recommendationData) {
      line(cards, recommendationError ? "推薦データを読み込めませんでした。" : "推薦データを読み込み中…", "recommendation-card");
      return;
    }
    var pe = $("paperText");
    var lines = pe && Recommender ? Recommender.parsePaperLines(pe.value) : [];
    if (!lines.length) {
      line(cards, "投稿予定論文のタイトル・Abstract・PDF/TXTを入力してください。", "recommendation-card");
      return;
    }
    if (!list.length) {
      line(cards, "該当する投稿先がありません。論文本文を長めに入れるか、条件を変えてみてください。", "recommendation-card");
      return;
    }
    list.slice(0, 5).forEach((r) => cards.appendChild(makeRecommendationCard(r)));
  }

  function render() {
    var recMode = state.mode === "recommend";
    if (recMode && !recommendationData && !recommendationError) loadRecommendationData();
    shown = recMode && !recommendationData ? [] : filter();
    drawn = 0;
    selectedIndex = -1;
    $("tbody").textContent = "";
    var pe = $("paperText");
    var paperMode = recMode && !!(pe && pe.value.trim() && Recommender);
    var cnt = paperMode
      ? "あなたの論文に合う投稿先 " + shown.length + " 件"
      : recMode ? "投稿先を探すには論文情報を入力してください"
      : shown.length + " 件 / 全 " + rows.length + " 件";
    if (!recMode && state.past && historyStatus === "loading") cnt += " ｜ 全履歴を読み込み中…";
    if (!recMode && state.past && historyStatus === "error") cnt += " ｜ 全履歴を読み込めませんでした";
    if (paperMode) {
      var _lines = Recommender.parsePaperLines(pe.value);
      var _auto = _lines.length ? Recommender.autoDetectCats(_lines) : [];
      if (_auto.length && !state.cats.length) {
        cnt += " ｜ 分野自動判定: " + _auto.map((k) => (DATA.categories && DATA.categories[k]) ? DATA.categories[k] : k).join(", ");
      }
      // AI 類似度の状態を明示（初回はモデル読込に数秒かかる）
      if (semState === "loading") { cnt += " ｜ AI 類似度 計算中…"; }
      else if (semState === "error") { cnt += " ｜ AI 類似度 利用不可（オフラインのため語彙のみ）"; }
    }
    $("count").textContent = cnt;
    var showHistoryStatus = !recMode && state.past && (historyStatus === "loading" || historyStatus === "error");
    $("historyStatus").hidden = !showHistoryStatus;
    if (showHistoryStatus) {
      $("historyStatusText").textContent = historyStatus === "loading"
        ? "過去の締切を読み込んでいます…"
        : "全履歴を読み込めませんでした。表示中のカタログは利用できます。";
      $("historyRetry").hidden = historyStatus !== "error";
    }
    if (recMode) {
      $("deadlineTableWrap").hidden = true;
      $("recommendationCards").hidden = false;
      $("empty").hidden = true;
      $("more").hidden = true;
      renderRecommendationCards(paperMode ? shown : []);
    } else {
      $("deadlineTableWrap").hidden = false;
      $("recommendationCards").hidden = true;
      if (!shown.length) {
        $("empty").textContent = "該当する締切はありません。";
        $("empty").hidden = false;
      } else {
        $("empty").hidden = true;
      }
      drawMore();
    }
    updatePresetActive();
  }

  function updateModeUi() {
    var recommend = state.mode === "recommend";
    var panel = $("controlsPanel");
    panel.classList.toggle("mode-recommend", recommend);
    panel.classList.toggle("mode-deadlines", !recommend);
    $("modeRecommend").setAttribute("aria-pressed", String(recommend));
    $("modeDeadlines").setAttribute("aria-pressed", String(!recommend));
  }

  function loadRecommendationData() {
    if (recommendationData || recommendationPromise || recommendationError) return;
    recommendationPromise = fetch("recommendation-index.json")
      .then((response) => { if (!response.ok) throw new Error("recommendation-index " + response.status); return response.json(); })
      .then((data) => {
        if (!data || !Array.isArray(data.conferences)) throw new Error("invalid recommendation-index");
        recommendationData = data;
        setRecommendationProfile(data);
        render();
      })
      .catch(() => { recommendationError = true; render(); });
  }

  function resolveHistoryRef() {
    var ref = DATA && DATA.history_ref;
    if (typeof ref !== "string" || !ref.trim()) return "";
    try {
      var url = new URL(ref, window.location.href);
      if (url.origin !== window.location.origin) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function stopHistoryLoad() {
    historyLoader.cancel();
    historyStatus = historyLoader.status;
  }

  function loadHistoryData() {
    if (state.mode !== "deadlines" || !state.past) return;
    if (historyLoader.data) {
      historyStatus = historyLoader.status;
      setDeadlineProfile(historyLoader.data);
      return;
    }
    var ref = resolveHistoryRef();
    if (!ref) {
      historyStatus = "error";
      setDeadlineProfile(DATA);
      render();
      return;
    }
    historyLoader.load(ref);
  }

  function setMode(mode) {
    state.mode = mode === "recommend" ? "recommend" : "deadlines";
    updateModeUi();
    writeUrl();
    if (state.mode === "recommend") {
      stopHistoryLoad();
      if (recommendationData) setRecommendationProfile(recommendationData);
      else loadRecommendationData();
    } else if (state.past) {
      loadHistoryData();
    } else {
      stopHistoryLoad();
      setDeadlineProfile(DATA);
    }
    render();
  }

  function readUrl() {
    var p = new URLSearchParams(window.location.search);
    state.mode = p.get("mode") === "recommend" ? "recommend" : "deadlines";
    state.q = p.get("q") || "";
    state.kind = KIND_LABEL[p.get("kind")] ? p.get("kind") : "";
    var rawRank = p.get("rank");
    state.rank = ["A*", "A", "B", "C", "N"].indexOf(rawRank) >= 0 ? rawRank : "";
    var rawWin = p.get("win");
    state.win = ["all", "7d", "30d", "90d", "180d", "future"].indexOf(rawWin) >= 0 ? rawWin : "all";
    state.est = p.get("est") === "1";
    state.domestic = p.get("domestic") === "1";
    state.past = p.get("past") === "1";
    state.cats = (p.get("cats") || "").split(",").filter((c) => Boolean(c) && Boolean(DATA.categories && DATA.categories[c]));
  }

  function writeUrl() {
    var p = new URLSearchParams();
    p.set("mode", state.mode);
    if (state.q) p.set("q", state.q);
    if (state.kind) p.set("kind", state.kind);
    if (state.rank) p.set("rank", state.rank);
    if (state.win !== "all") p.set("win", state.win);
    if (state.est) p.set("est", "1");
    if (state.domestic) p.set("domestic", "1");
    if (state.past) p.set("past", "1");
    if (state.cats.length) p.set("cats", state.cats.join(","));
    var str = p.toString();
    history.replaceState(null, "", str ? "?" + str : window.location.pathname);
  }

  function toForm() {
    $("q").value = state.q;
    $("kind").value = state.kind;
    $("rank").value = state.rank;
    $("win").value = state.win;
    $("est").checked = state.est;
    $("domestic").checked = state.domestic;
    $("past").checked = state.past;
    Array.prototype.forEach.call(catsBox.querySelectorAll("input"), (chk) => {
      chk.checked = state.cats.indexOf(chk.value) >= 0;
    });
    updatePresetActive();
  }

  function fromForm() {
    state.q = $("q").value;
    state.kind = $("kind").value;
    state.rank = $("rank").value;
    state.win = $("win").value;
    state.est = $("est").checked;
    state.domestic = $("domestic").checked;
    state.past = $("past").checked;
    state.cats = [];
    Array.prototype.forEach.call(catsBox.querySelectorAll("input"), (chk) => {
      if (chk.checked) state.cats.push(chk.value);
    });
  }

  function apply() {
    fromForm();
    writeUrl();
    if (state.mode === "deadlines" && state.past) {
      loadHistoryData();
    } else {
      stopHistoryLoad();
      if (state.mode === "deadlines") setDeadlineProfile(DATA);
    }
    render();
  }

  // ---- paper file upload（PDF/TXT → editable structured records） ----
  var PDFJS_VERSION = "3.11.174";
  var PDFJS_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  var PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  var PDF_MAX_BYTES = 20 * 1024 * 1024;
  var PDF_MAX_PAGES = 100;
  var PDF_PAGE_LIMIT = 3;
  var PDF_TIMEOUT_MS = 15000;
  var pdfAbortController = null;
  var pdfJob = 0;
  var paperPrimaryVenue = "";

  function loadPdfJs(cb) {
    if (PDFJS_SCRIPT.indexOf("/" + PDFJS_VERSION + "/") < 0 || PDFJS_WORKER.indexOf("/" + PDFJS_VERSION + "/") < 0) { cb(false); return; }
    if (window.pdfjsLib) { cb(String(window.pdfjsLib.version || PDFJS_VERSION) === PDFJS_VERSION); return; }
    var s = document.createElement("script");
    s.src = PDFJS_SCRIPT;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      cb(true);
    };
    s.onerror = () => { cb(false); };
    document.head.appendChild(s);
  }
  function abortError() {
    var error = new Error("PDF extraction cancelled");
    error.name = "AbortError";
    return error;
  }
  function readPdf(buf, signal) {
    var task = window.pdfjsLib.getDocument({ data: buf });
    var timer;
    var stop = () => { if (task.destroy) task.destroy(); };
    return new Promise((resolve, reject) => {
      var finish = (fn, value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn(value);
      };
      var onAbort = () => { stop(); finish(reject, abortError()); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { stop(); finish(reject, new Error("PDF extraction timed out")); }, PDF_TIMEOUT_MS);
      task.promise.then((doc) => {
        if (doc.numPages > PDF_MAX_PAGES) throw new Error("PDF has too many pages");
        var pages = [];
        for (var i = 1; i <= Math.min(doc.numPages, PDF_PAGE_LIMIT); i++) {
          pages.push(doc.getPage(i).then((page) => page.getTextContent().then((content) => content.items)));
        }
        return Promise.all([
          Promise.all(pages),
          doc.getMetadata().catch(() => ({ info: {} })),
        ]);
      }).then(([pages, metadata]) => finish(resolve, { pages, metadata }), (error) => finish(reject, error));
    });
  }
  function textRecord(name, text) {
    return Recommender.textPaperRecord(text, name);
  }
  function readPaperFile(file, signal) {
    if (file.size > PDF_MAX_BYTES) return Promise.reject(new Error("file is too large"));
    if (/\.txt$/i.test(file.name)) return file.text().then((text) => textRecord(file.name, text));
    return file.arrayBuffer().then((buf) => readPdf(buf, signal)).then((result) =>
      Recommender.pdfPaperRecord(result.metadata, result.pages, file.name),
    );
  }
  function syncPaperText() {
    /** @type {SitePaperRecord} */
    var primary = {
      title: $("paperPrimaryTitle").value.trim(),
      abstract: $("paperPrimaryAbstract").value.trim(),
      keywords: $("paperPrimaryKeywords").value.trim(),
      venue: paperPrimaryVenue,
    };
    /** @type {SitePaperRecord[]} */
    var records = primary.title || primary.abstract || primary.keywords ? [primary] : [];
    records = records.concat(Recommender.parsePaperLines($("paperReferences").value));
    $("paperText").value = records.length ? JSON.stringify(records) : "";
  }
  function setPrimaryRecord(record) {
    $("paperPrimaryTitle").value = record && record.title || "";
    $("paperPrimaryAbstract").value = record && record.abstract || "";
    $("paperPrimaryKeywords").value = record && record.keywords || "";
    paperPrimaryVenue = record && record.venue || "";
  }
  var paperFiles = /** @type {HTMLInputElement} */ ($("paperFiles"));
  var cancelPdf = $("cancelPdf");
  cancelPdf.addEventListener("click", () => {
    if (pdfAbortController) pdfAbortController.abort();
  });
  paperFiles.addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files);
    if (!files.length) return;
    var label = document.getElementById("paperFileLabel");
    label.textContent = "読み込み中…";
    cancelPdf.hidden = false;
    var job = ++pdfJob;
    pdfAbortController = new AbortController();
    var signal = pdfAbortController.signal;
    /** @type {Promise<void>} */
    var load = files.some((file) => !/\.txt$/i.test(file.name))
      ? new Promise((resolve, reject) => loadPdfJs((ok) => ok ? resolve() : reject(new Error("pdfjs unavailable"))))
      : Promise.resolve();
    load.then(() => Promise.all(files.map((file) => readPaperFile(file, signal)))).then((records) => {
      if (job !== pdfJob || signal.aborted) throw abortError();
      setPrimaryRecord(records[0] || {});
      $("paperReferences").value = records.slice(1).map((record) =>
        [record.title, record.keywords, record.venue].filter(Boolean).join(" | "),
      ).join("\n");
      syncPaperText();
      label.textContent = files.map((f) => f.name).join(", ");
      apply();
      scheduleSemantic();
    }).catch((error) => {
      label.textContent = error.name === "AbortError" ? "PDF 読込をキャンセルしました" : "PDF 読込に失敗しました: " + error.message;
    }).finally(() => {
      if (job === pdfJob) {
        pdfAbortController = null;
        cancelPdf.hidden = true;
      }
    });
    this.value = "";
  });

  // ---- wiring ----
  var timer = null;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 180);
  });
  $("paperText").addEventListener("input", () => {
    invalidateSemantic();
    clearTimeout(timer);
    timer = setTimeout(() => { apply(); scheduleSemantic(); }, 200);
  });
  ["paperPrimaryTitle", "paperPrimaryAbstract", "paperPrimaryKeywords", "paperReferences"].forEach((id) => {
    $(id).addEventListener("input", () => {
      syncPaperText();
      invalidateSemantic();
      clearTimeout(timer);
      timer = setTimeout(() => { apply(); scheduleSemantic(); }, 200);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".sample-btn"), (b) => {
    b.addEventListener("click", () => {
      var sample = Recommender.parsePaperLines(b.getAttribute("data-sample"))[0] || {};
      setPrimaryRecord(sample);
      $("paperReferences").value = "";
      syncPaperText();
      apply();
      scheduleSemantic();
    });
  });
  ["kind", "rank", "win", "est", "domestic", "past"].forEach((id) => {
    $(id).addEventListener("change", apply);
  });
  catsBox.addEventListener("change", apply);
  $("more").addEventListener("click", drawMore);
  $("modeRecommend").addEventListener("click", () => setMode("recommend"));
  $("modeDeadlines").addEventListener("click", () => setMode("deadlines"));
  $("historyRetry").addEventListener("click", () => {
    if (state.mode !== "deadlines" || !state.past) return;
    loadHistoryData();
    render();
  });
  $("reset").addEventListener("click", () => {
    state = { mode: state.mode, q: "", cats: [], kind: "", rank: "", win: "all", est: false, domestic: false, past: false };
    $("paperText").value = "";
    setPrimaryRecord({});
    $("paperReferences").value = "";
    paperFiles.value = "";
    document.getElementById("paperFileLabel").textContent = "未選択";
    stopHistoryLoad();
    if (state.mode === "deadlines") setDeadlineProfile(DATA);
    invalidateSemantic();
    toForm();
    writeUrl();
    render();
  });

  if (DATA.generated_at) {
    $("genat").textContent = "データ生成: " + DATA.generated_at;
  }
  var srcs = (DATA.sources || []).map((s) => s.name + (s.repo ? " (" + s.repo + (s.license ? ", " + s.license : "") + ")" : ""));
  $("sources").textContent = srcs.length ? srcs.join(" / ") : "-";

  var localSrc = (DATA.sources || []).filter((s) => s.name === "local")[0];
  if (localSrc && safeExternalUrl(localSrc.url)) {
    var a = document.createElement("a");
    a.href = safeExternalUrl(localSrc.url);
    a.textContent = "リポジトリ";
    $("repolink").appendChild(document.createTextNode(" / "));
    $("repolink").appendChild(a);
  }

  readUrl();
  updateModeUi();
  toForm();
  if (state.mode === "deadlines" && state.past) loadHistoryData();
  render();
})();
