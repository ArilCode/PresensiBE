(function () {
  "use strict";
  var C = window.APP_CONFIG || {};
  var HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  var BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  var STATUS = ["Hadir", "Sakit", "Izin", "Alfa"];
  var IDLE_MS = 30 * 60 * 1000;          // keluar otomatis setelah 30 menit tidak aktif
  var $ = function (id) { return document.getElementById(id); };

  // ---------- helper aman (semua teks lewat textContent = anti XSS) ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function safeUrl(u) { return /^(https:\/\/|mailto:)/i.test(u) ? u : "#"; }
  function linkBtn(label, url) {
    var a = el("a", "", label);
    a.href = safeUrl(url);
    if (a.href.indexOf("mailto:") !== 0) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }
  function todayWIB() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()); }
  function parseDate(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function hariTgl(s) { var d = parseDate(s); return HARI[d.getDay()] + ", " + d.getDate() + " " + BULAN[d.getMonth()] + " " + d.getFullYear(); }
  function waktuWIB(ts) {
    return new Date(ts).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function kelasBadge(s) { return String(s).toLowerCase().replace(/[^a-z]/g, ""); }

  var noticeTimer;
  function notice(msg, type) {
    var n = $("notice");
    n.textContent = msg; n.className = "notice " + (type || ""); n.hidden = !msg;
    clearTimeout(noticeTimer);
    if (msg) { window.scrollTo(0, 0); noticeTimer = setTimeout(function () { n.hidden = true; }, 7000); }
  }
  function friendly(err) {
    var m = (err && err.message) || "";
    if (/duplicate key|unique/i.test(m)) return "Siswa ini sudah punya presensi di tanggal tersebut.";
    if (/non-Islam/i.test(m)) return "Siswa non-Islam tidak ikut presensi sholat.";
    if (/Hanya developer/i.test(m)) return "Hanya developer yang boleh mengubah tanggal/jam.";
    if (/row-level security|permission denied|Tidak punya akses|Khusus developer/i.test(m)) return "Kamu tidak punya izin untuk aksi ini.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Tidak bisa terhubung. Periksa internetmu.";
    return "Terjadi kesalahan. Coba lagi.";
  }

  // ---------- halaman umum ----------
  $("tahun").textContent = new Date().getFullYear();   // copyright otomatis
  $("foot-dev").textContent = C.DEV_NAME || "ACE";

  function buildAbout(container) {
    container.innerHTML = "";
    container.appendChild($("aboutTpl").content.cloneNode(true));
    container.querySelector(".a-guru").textContent = C.GURU || "";
    container.querySelector(".a-dev").textContent = C.DEV_NAME || "ACE";
    var links = container.querySelector(".a-links"), rep = container.querySelector(".a-report");
    (C.LINKS || []).forEach(function (l) { links.appendChild(linkBtn(l.label, l.url)); });
    if (C.EMAIL) {
      links.appendChild(linkBtn("Email", "mailto:" + C.EMAIL));
      rep.appendChild(linkBtn("Kirim email laporan", "mailto:" + C.EMAIL + "?subject=" + encodeURIComponent("Laporan masalah Presensi BE")));
    }
    (C.LINKS || []).slice(0, 1).forEach(function (l) { rep.appendChild(linkBtn("Lapor via " + l.label, l.url)); });
  }
  buildAbout(document.querySelector("#tab-tentang .aboutbox"));

  // ---------- Supabase ----------
  var configured = C.SUPABASE_URL && C.SUPABASE_KEY && C.SUPABASE_URL.indexOf("GANTI") === -1 && C.SUPABASE_KEY.indexOf("GANTI") === -1;
  if (!configured || !window.supabase) {
    $("loginView").hidden = false;
    $("l-error").textContent = "Web belum disambungkan ke database. Isi file config.js terlebih dahulu.";
    $("l-error").hidden = false;
    $("l-btn").disabled = true;
    return;
  }
  // Sesi disimpan di sessionStorage: otomatis hilang saat tab/browser ditutup.
  var sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
    auth: { persistSession: true, storage: window.sessionStorage, autoRefreshToken: true, detectSessionInUrl: false }
  });

  var state = { role: null, siswa: [], todayMap: {}, mode: "single", editing: null };

  // ---------- banner info ----------
  function loadBanner() {
    return sb.rpc("get_info_aktif").then(function (r) {
      var b = $("banner"), txt = r.data && r.data.length ? r.data[0].pesan : "";
      b.textContent = txt ? "📢 " + txt : ""; b.hidden = !txt;
      $("i-aktif").textContent = txt || "— (tidak ada)";
    });
  }

  // ---------- LOGIN ----------
  var fails = 0, lockUntil = 0;
  $("l-show").addEventListener("click", function () {
    var p = $("l-pass"); p.type = p.type === "password" ? "text" : "password";
  });
  $("l-about").addEventListener("click", function () {
    var box = $("loginView").querySelector(".about-inline");
    if (box) { box.remove(); return; }
    box = el("div", "about-inline"); buildAbout(box);
    $("loginView").appendChild(box);
    box.scrollIntoView({ behavior: "smooth" });
  });

  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("l-error"); err.hidden = true;
    var wait = Math.ceil((lockUntil - Date.now()) / 1000);
    if (wait > 0) { err.textContent = "Terlalu banyak percobaan. Tunggu " + wait + " detik."; err.hidden = false; return; }
    var email = $("l-email").value.trim(), pass = $("l-pass").value;
    if (!email || !pass) { err.textContent = "Isi email dan password."; err.hidden = false; return; }
    var btn = $("l-btn"); btn.disabled = true; btn.textContent = "Memeriksa…";
    sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
      if (r.error || !r.data.session) throw new Error("login");
      return loadRole().then(function (role) {
        if (!role) { return sb.auth.signOut().then(function () { throw new Error("norole"); }); }
        $("l-pass").value = "";
        return sb.rpc("catat_log", { p_event: "login", p_ua: navigator.userAgent }).then(function () { return enterApp(role); });
      });
    }).catch(function (e) {
      fails++;
      if (fails >= 5) { lockUntil = Date.now() + 60000; fails = 0; }
      // pesan sengaja dibuat umum agar tidak membocorkan email mana yang benar
      err.textContent = e.message === "norole" ? "Akun ini tidak punya akses ke web ini." : "Email atau password salah.";
      err.hidden = false;
    }).then(function () { btn.disabled = false; btn.textContent = "Masuk"; });
  });

  function loadRole() {
    return sb.auth.getUser().then(function (u) {
      if (!u.data || !u.data.user) return null;
      return sb.from("profiles").select("role").eq("id", u.data.user.id).maybeSingle().then(function (r) {
        return r.data && (r.data.role === "developer" || r.data.role === "author") ? r.data.role : null;
      });
    });
  }

  function showLogin() {
    stopIdle();
    $("appView").hidden = true; $("loginView").hidden = false;
    var ab = $("loginView").querySelector(".about-inline"); if (ab) ab.remove();
    state.role = null; state.siswa = []; state.todayMap = {};
    loadBanner();
  }

  function doLogout(event) {
    stopIdle();
    return sb.rpc("catat_log", { p_event: event, p_ua: navigator.userAgent })
      .then(function () { return sb.auth.signOut(); })
      .catch(function () { return sb.auth.signOut(); })
      .then(function () { showLogin(); if (event === "timeout") { $("l-error").textContent = "Kamu keluar otomatis karena 30 menit tidak aktif."; $("l-error").hidden = false; } });
  }
  $("logoutBtn").addEventListener("click", function () { doLogout("logout"); });
  sb.auth.onAuthStateChange(function (evt) { if (evt === "SIGNED_OUT" && !$("appView").hidden) showLogin(); });

  // ---------- idle timeout ----------
  var idleTimer, idleBound = false;
  function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(function () { doLogout("timeout"); }, IDLE_MS); }
  function startIdle() {
    resetIdle();
    if (!idleBound) {
      ["click", "keydown", "touchstart", "scroll"].forEach(function (e) { window.addEventListener(e, function () { if (state.role) resetIdle(); }, { passive: true }); });
      idleBound = true;
    }
  }
  function stopIdle() { clearTimeout(idleTimer); }

  // ---------- MASUK APLIKASI ----------
  function enterApp(role) {
    state.role = role;
    $("loginView").hidden = true; $("appView").hidden = false;
    $("who").textContent = (role === "developer" ? "Developer" : "Author");
    document.querySelectorAll(".dev-only").forEach(function (n) { n.hidden = role !== "developer"; });
    $("p-today").textContent = hariTgl(todayWIB());
    $("d-tanggal").value = todayWIB();
    startIdle();
    switchTab("presensi");
    return Promise.all([loadSiswa(), loadBanner()]).then(function () { return refreshToday(); });
  }

  // ---------- TAB ----------
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    document.querySelectorAll(".tabview").forEach(function (v) { v.hidden = v.id !== "tab-" + name; });
    notice("");
    if (name === "data") loadData();
    if (name === "monitor" && state.role === "developer") loadMonitor();
    if (name === "server" && state.role === "developer") loadServer();
    if (name === "info" && state.role === "developer") loadBanner();
    if (name === "presensi") refreshToday();
  }
  $("tabs").addEventListener("click", function (e) {
    var t = e.target.closest(".tab"); if (t) switchTab(t.dataset.tab);
  });

  // ---------- SISWA & PRESENSI HARI INI ----------
  function loadSiswa() {
    return sb.from("siswa").select("id,nama,kelas,nonis").order("nama", { ascending: true }).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      state.siswa = r.data || [];
    });
  }
  function refreshToday() {
    return sb.from("presensi").select("siswa_id,status").eq("tanggal", todayWIB()).then(function (r) {
      state.todayMap = {};
      (r.data || []).forEach(function (x) { state.todayMap[x.siswa_id] = x.status; });
      renderSingle(); renderBulk();
    });
  }

  // ---------- MODE ----------
  document.querySelectorAll("input[name=mode]").forEach(function (r) {
    r.addEventListener("change", function () {
      state.mode = r.value;
      $("singleForm").hidden = r.value !== "single";
      $("bulkForm").hidden = r.value !== "bulk";
    });
  });

  function chipGroup(name, selected, disabled) {
    var wrap = el("div", "chips");
    STATUS.forEach(function (s) {
      var lab = document.createElement("label");
      var inp = document.createElement("input");
      inp.type = "radio"; inp.name = name; inp.value = s;
      if (s === selected) inp.checked = true;
      if (disabled) inp.disabled = true;
      lab.appendChild(inp); lab.appendChild(el("span", "", s));
      wrap.appendChild(lab);
    });
    return wrap;
  }

  // satu per satu
  function renderSingle() {
    var sel = $("s-siswa"), keep = sel.value;
    sel.innerHTML = "";
    var o0 = el("option", "", "— Pilih nama siswa —"); o0.value = ""; sel.appendChild(o0);
    state.siswa.forEach(function (s) {
      var done = state.todayMap[s.id];
      var label = s.nama + " — " + s.kelas + (s.nonis ? " (Non-Islam)" : done ? " ✓ sudah: " + done : "");
      var o = el("option", "", label); o.value = s.id;
      if (s.nonis || done) o.disabled = true;           // nonis tidak bisa diklik
      sel.appendChild(o);
    });
    var kept = keep && sel.querySelector('option[value="' + keep + '"]');
    if (kept && !kept.disabled) sel.value = keep;
  }
  // (chip dibuat langsung supaya tetap ada ketika dirender ulang)
  function mountSingleChips() {
    var box = $("s-status"); box.innerHTML = "";
    var g = chipGroup("s-st", "Hadir", false);
    while (g.firstChild) box.appendChild(g.firstChild);
  }

  $("singleForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var id = $("s-siswa").value, st = (document.querySelector("input[name=s-st]:checked") || {}).value;
    if (!id) { notice("Pilih nama siswa dulu.", "err"); return; }
    if (STATUS.indexOf(st) === -1) { notice("Pilih status presensi.", "err"); return; }
    var btn = $("s-btn"); btn.disabled = true; btn.textContent = "Mengirim…";
    sb.from("presensi").insert({ siswa_id: id, status: st }).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); }
      else { notice("Presensi terkirim ✓", "ok"); $("s-siswa").value = ""; }
      return refreshToday();
    }).then(function () { btn.disabled = false; btn.textContent = "Kirim presensi"; });
  });

  // sekaligus
  function renderBulk() {
    var list = $("b-list"); list.innerHTML = "";
    state.siswa.forEach(function (s) {
      var done = state.todayMap[s.id];
      var off = s.nonis || !!done;
      var item = el("div", "bitem" + (off ? " off" : ""));
      var nm = el("div", "nm", s.nama);
      if (s.nonis) nm.appendChild(el("span", "tag", "Non-Islam"));
      else if (done) nm.appendChild(el("span", "tag", "sudah: " + done));
      item.appendChild(nm);
      item.appendChild(el("div", "kl", s.kelas));
      item.appendChild(chipGroup("b-" + s.id, off ? "" : "Hadir", off));
      list.appendChild(item);
    });
  }
  $("bulkForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var rows = [];
    state.siswa.forEach(function (s) {
      if (s.nonis || state.todayMap[s.id]) return;
      var c = document.querySelector('input[name="b-' + s.id + '"]:checked');
      if (c && STATUS.indexOf(c.value) !== -1) rows.push({ siswa_id: s.id, status: c.value });
    });
    if (!rows.length) { notice("Semua siswa sudah dipresensi hari ini.", "err"); return; }
    if (!window.confirm("Kirim presensi untuk " + rows.length + " siswa?")) return;
    var btn = $("b-btn"); btn.disabled = true; btn.textContent = "Mengirim…";
    sb.from("presensi").upsert(rows, { onConflict: "siswa_id,tanggal", ignoreDuplicates: true }).select("id").then(function (r) {
      if (r.error) notice(friendly(r.error), "err");
      else notice((r.data || []).length + " presensi terkirim ✓", "ok");
      return refreshToday();
    }).then(function () { btn.disabled = false; btn.textContent = "Kirim presensi sekaligus"; });
  });

  // ---------- DATA ----------
  function loadData() {
    var tgl = $("d-tanggal").value || todayWIB();
    var list = $("d-list"); list.innerHTML = "";
    sb.from("presensi").select("id,tanggal,jam,status,siswa:siswa_id(nama,kelas)").eq("tanggal", tgl).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var rows = (r.data || []).slice().sort(function (a, b) { return (a.siswa.nama).toLowerCase() < (b.siswa.nama).toLowerCase() ? -1 : 1; });
      $("d-kosong").hidden = rows.length > 0;
      rows.forEach(function (x) {
        var it = el("div", "ditem");
        var top = el("div", "top2");
        var left = el("div");
        left.appendChild(el("div", "nm", x.siswa.nama));
        left.appendChild(el("div", "meta", x.siswa.kelas + " • " + hariTgl(x.tanggal) + " • " + String(x.jam).slice(0, 5)));
        top.appendChild(left);
        top.appendChild(el("span", "badge " + kelasBadge(x.status), x.status));
        it.appendChild(top);
        var act = el("div", "act");
        var be = el("button", "btn small", "Ubah"); be.type = "button";
        be.addEventListener("click", function () { openEdit(x); });
        var bd = el("button", "btn small danger", "Hapus"); bd.type = "button";
        bd.addEventListener("click", function () { hapus(x); });
        act.appendChild(be); act.appendChild(bd); it.appendChild(act);
        list.appendChild(it);
      });
    });
  }
  $("d-muat").addEventListener("click", loadData);
  $("d-tanggal").addEventListener("change", loadData);

  function hapus(x) {
    if (!window.confirm("Hapus presensi " + x.siswa.nama + " (" + x.status + ")? Tindakan ini tidak bisa dibatalkan.")) return;
    sb.from("presensi").delete().eq("id", x.id).select("id").then(function (r) {
      if (r.error) notice(friendly(r.error), "err");
      else if (!r.data || !r.data.length) notice("Data tidak terhapus (tidak ada izin atau sudah hilang).", "err");
      else notice("Presensi dihapus.", "ok");
      loadData(); refreshToday();
    });
  }

  var dlg = $("editDlg");
  function openEdit(x) {
    state.editing = x;
    $("e-nama").textContent = x.siswa.nama + " — " + x.siswa.kelas;
    $("e-status").value = x.status;
    $("e-dev").hidden = state.role !== "developer";
    $("e-tanggal").value = x.tanggal;
    $("e-jam").value = String(x.jam).slice(0, 5);
    dlg.showModal();
  }
  $("e-batal").addEventListener("click", function () { dlg.close(); });
  $("editForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var x = state.editing; if (!x) return;
    var st = $("e-status").value;
    if (STATUS.indexOf(st) === -1) return;
    var patch = { status: st };
    if (state.role === "developer") {
      var t = $("e-tanggal").value, j = $("e-jam").value;
      if (!t || !j) { notice("Tanggal dan jam wajib diisi.", "err"); return; }
      patch.tanggal = t; patch.jam = j.length === 5 ? j + ":00" : j;
    }
    var btn = $("e-simpan"); btn.disabled = true;
    sb.from("presensi").update(patch).eq("id", x.id).select("id").then(function (r) {
      if (r.error) notice(friendly(r.error), "err");
      else if (!r.data || !r.data.length) notice("Perubahan tidak tersimpan (tidak ada izin).", "err");
      else notice("Perubahan disimpan ✓", "ok");
      dlg.close(); btn.disabled = false;
      loadData(); refreshToday();
    });
  });

  // ---------- MONITORING (developer) ----------
  function loadMonitor() {
    var body = $("m-body"); body.innerHTML = "";
    sb.from("log_login").select("waktu,email,role,event,ip,perangkat").order("waktu", { ascending: false }).limit(100).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var label = { login: "Masuk", logout: "Keluar", timeout: "Keluar otomatis" };
      (r.data || []).forEach(function (x) {
        var tr = el("tr");
        [waktuWIB(x.waktu), x.email || "-", x.role || "-", label[x.event] || x.event, x.ip || "-"].forEach(function (v) { tr.appendChild(el("td", "", v)); });
        var ua = el("td", "ua", x.perangkat || "-"); ua.title = x.perangkat || ""; tr.appendChild(ua);
        body.appendChild(tr);
      });
    });
  }
  $("m-muat").addEventListener("click", loadMonitor);

  // ---------- INFO SERVER (developer) ----------
  function loadServer() {
    var dl = $("v-list"); dl.innerHTML = "";
    var t0 = performance.now();
    sb.rpc("server_info").then(function (r) {
      var ping = Math.round(performance.now() - t0);
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var d = r.data || {};
      var rows = [
        ["Status database", "Terhubung ✓"],
        ["Kecepatan respons", ping + " ms"],
        ["Waktu server (WIB)", waktuWIB(d.waktu_server)],
        ["Versi database", d.versi_db],
        ["Ukuran database", d.ukuran_db],
        ["Jumlah siswa", d.jumlah_siswa],
        ["Total presensi", d.jumlah_presensi],
        ["Presensi hari ini", d.presensi_hari_ini],
        ["Presensi terakhir dikirim", d.presensi_terakhir ? waktuWIB(d.presensi_terakhir) : "—"],
        ["Total catatan login", d.jumlah_log_login],
        ["Host Supabase", new URL(C.SUPABASE_URL).host],
        ["Browser kamu", navigator.userAgent.slice(0, 90)]
      ];
      rows.forEach(function (x) { dl.appendChild(el("dt", "", x[0])); dl.appendChild(el("dd", "", String(x[1]))); });
    });
  }
  $("v-muat").addEventListener("click", loadServer);

  // ---------- TULIS INFO (developer) ----------
  $("i-text").addEventListener("input", function () { $("i-count").textContent = $("i-text").value.length; });
  $("i-kirim").addEventListener("click", function () {
    var t = $("i-text").value.trim();
    if (!t) { notice("Tulis isi info dulu.", "err"); return; }
    sb.rpc("tulis_info", { p_pesan: t }).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      $("i-text").value = ""; $("i-count").textContent = "0";
      notice("Banner info ditampilkan ✓", "ok"); loadBanner();
    });
  });
  $("i-mati").addEventListener("click", function () {
    sb.rpc("matikan_info").then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      notice("Banner info dimatikan.", "ok"); loadBanner();
    });
  });

  // ---------- MULAI ----------
  mountSingleChips();
  sb.auth.getSession().then(function (r) {
    if (r.data && r.data.session) {
      loadRole().then(function (role) { if (role) enterApp(role); else { sb.auth.signOut(); showLogin(); } });
    } else {
      showLogin();
    }
  });
})();
