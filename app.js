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
    if (/Presensi ditutup/i.test(m)) return m;
    if (/Keterangan izin wajib/i.test(m)) return "Status Izin wajib diisi keterangannya.";
    if (/catatan tanggal lain/i.test(m)) return "Hanya developer yang boleh mengubah catatan tanggal lain.";
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

  var state = { libur: null, role: null, siswa: [], todayMap: {}, mode: "single", editing: null };

  // ---------- banner info ----------
  function loadBanner() {
    return sb.rpc("get_info_aktif").then(function (r) {
      var txt = r.data && r.data.length ? r.data[0].pesan : "";
      document.querySelectorAll(".infobar").forEach(function (b) {
        b.querySelector(".info-text").textContent = txt; b.hidden = !txt;
      });
    });
  }
  document.addEventListener("click", function (e) {
    var x = e.target.closest && e.target.closest(".info-x");
    if (x) x.closest(".infobar").hidden = true;
  });

  // ---------- LOGIN ----------
  var fails = 0, lockUntil = 0;
  $("l-show").addEventListener("click", function () {
    var p = $("l-pass"), show = p.type === "password";
    p.type = show ? "text" : "password";                  // dilihat = mata terbuka, disembunyikan = mata dicoret
    $("eye-on").toggleAttribute("hidden", !show); $("eye-off").toggleAttribute("hidden", show);
    $("l-show").setAttribute("aria-pressed", String(show));
    $("l-show").setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
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

  function showTimeoutMsg() {
    $("l-error").textContent = "Sesi berakhir karena 30 menit tidak aktif. Silakan login ulang.";
    $("l-error").hidden = false;
  }
  var loggingOut = false;
  function doLogout(event) {
    if (!state.role || loggingOut) return Promise.resolve();   // sudah/sedang keluar
    loggingOut = true;
    stopIdle();
    return sb.rpc("catat_log", { p_event: event, p_ua: navigator.userAgent })
      .then(function () { return sb.auth.signOut(); })
      .catch(function () { return sb.auth.signOut(); })
      .then(function () { loggingOut = false; showLogin(); if (event === "timeout") { showTimeoutMsg(); } });
  }
  $("logoutBtn").addEventListener("click", function () { doLogout("logout"); });
  sb.auth.onAuthStateChange(function (evt) { if (evt === "SIGNED_OUT" && !$("appView").hidden) showLogin(); });

  // ---------- idle timeout (30 menit) ----------
  // Berbasis JAM (timestamp), bukan hanya timer, supaya tetap bekerja walau HP dikunci /
  // tab di latar belakang / browser menghentikan timer.
  var LAST_KEY = "presensi_last_active", idleBound = false, idleIv = null, lastTouch = 0;
  function getLast() { try { return +sessionStorage.getItem(LAST_KEY) || 0; } catch (e) { return 0; } }
  function touch(force) {
    var n = Date.now();
    if (!force && n - lastTouch < 1000) return;           // batasi tulis 1x per detik
    lastTouch = n;
    try { sessionStorage.setItem(LAST_KEY, String(n)); } catch (e) { /* diabaikan */ }
  }
  function idleExpired() { var l = getLast(); return !l || Date.now() - l > IDLE_MS; }
  function checkIdle() { if (state.role && idleExpired()) doLogout("timeout"); }
  function startIdle() {
    touch(true);
    if (!idleBound) {
      ["pointerdown", "click", "keydown", "touchstart", "scroll", "input"].forEach(function (e) {
        window.addEventListener(e, function () { if (state.role) { if (idleExpired()) checkIdle(); else touch(); } }, { passive: true, capture: true });
      });
      document.addEventListener("visibilitychange", function () { if (!document.hidden) checkIdle(); });
      window.addEventListener("focus", checkIdle);
      window.addEventListener("pageshow", checkIdle);
      idleBound = true;
    }
    clearInterval(idleIv);
    idleIv = setInterval(checkIdle, 15000);
  }
  function stopIdle() { clearInterval(idleIv); idleIv = null; }

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
    return Promise.all([loadSiswa(), loadBanner(), noteLoad("np", todayWIB())]).then(function () { return refreshToday(); });
  }

  // ---------- TAB ----------
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === name); });
    document.querySelectorAll(".tabview").forEach(function (v) { v.hidden = v.id !== "tab-" + name; });
    notice("");
    if (name === "data") loadData();
    if (name === "monitor" && state.role === "developer") loadMonitor();
    if (name === "server" && state.role === "developer") loadServer();
    if (name === "info" && state.role === "developer") { loadBanner(); loadInfoList(); }
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
  // hari libur: Jumat/Sabtu/Minggu, libur nasional, cuti bersama -> form presensi dikunci
  function cekLibur() {
    return sb.rpc("alasan_libur", { p_tanggal: todayWIB() }).then(function (r) {
      state.libur = (!r.error && typeof r.data === "string" && r.data) ? r.data : null;
      $("libur-card").hidden = !state.libur;
      $("libur-text").textContent = state.libur || "";
      $("p-fs").disabled = !!state.libur;
    }).catch(function () { state.libur = null; });
  }
  function refreshToday() {
    return cekLibur().then(function () { return sb.from("presensi").select("siswa_id,status").eq("tanggal", todayWIB()); }).then(function (r) {
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

  $("s-status").addEventListener("change", function () {
    var st = (document.querySelector("input[name=s-st]:checked") || {}).value;
    $("s-ket-wrap").hidden = st !== "Izin";
    if (st === "Izin") $("s-ket").focus();
  });
  $("singleForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (state.libur) { notice("Presensi ditutup: " + state.libur, "err"); return; }
    var id = $("s-siswa").value, st = (document.querySelector("input[name=s-st]:checked") || {}).value;
    if (!id) { notice("Pilih nama siswa dulu.", "err"); return; }
    if (STATUS.indexOf(st) === -1) { notice("Pilih status presensi.", "err"); return; }
    var row = { siswa_id: id, status: st };
    if (st === "Izin") {
      var k = $("s-ket").value.trim();
      if (!k) { notice("Isi keterangan izin dulu.", "err"); $("s-ket").focus(); return; }
      row.keterangan = k;
    }
    var btn = $("s-btn"); btn.disabled = true; btn.textContent = "Mengirim…";
    sb.from("presensi").insert(row).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); }
      else { notice("Presensi terkirim ✓", "ok"); $("s-siswa").value = ""; $("s-ket").value = ""; $("s-ket-wrap").hidden = true; mountSingleChips(); }
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
      var grp = chipGroup("b-" + s.id, off ? "" : "Hadir", off);
      item.appendChild(grp);
      if (!off) {
        var kw = el("div", "ketin"); kw.hidden = true;
        var ki = document.createElement("input");
        ki.type = "text"; ki.maxLength = 150; ki.id = "bk-" + s.id; ki.placeholder = "Keterangan izin (wajib)";
        kw.appendChild(ki); item.appendChild(kw);
        grp.addEventListener("change", function () {
          var c = item.querySelector("input[type=radio]:checked");
          kw.hidden = !(c && c.value === "Izin");
          if (!kw.hidden) ki.focus();
        });
      }
      list.appendChild(item);
    });
  }
  $("bulkForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (state.libur) { notice("Presensi ditutup: " + state.libur, "err"); return; }
    var rows = [], missing = [];
    state.siswa.forEach(function (s) {
      if (s.nonis || state.todayMap[s.id]) return;
      var c = document.querySelector('input[name="b-' + s.id + '"]:checked');
      if (c && STATUS.indexOf(c.value) !== -1) {
        var row = { siswa_id: s.id, status: c.value };
        if (c.value === "Izin") {
          var k = ($("bk-" + s.id).value || "").trim();
          if (!k) { missing.push(s.nama); return; }
          row.keterangan = k;
        }
        rows.push(row);
      }
    });
    if (missing.length) { notice("Isi keterangan izin untuk: " + missing.join(", "), "err"); return; }
    if (!rows.length) { notice("Semua siswa sudah dipresensi hari ini.", "err"); return; }
    if (!window.confirm("Kirim presensi untuk " + rows.length + " siswa?")) return;
    var btn = $("b-btn"); btn.disabled = true; btn.textContent = "Mengirim…";
    sb.from("presensi").upsert(rows, { onConflict: "siswa_id,tanggal", ignoreDuplicates: true }).select("id").then(function (r) {
      if (r.error) notice(friendly(r.error), "err");
      else notice((r.data || []).length + " presensi terkirim ✓", "ok");
      return refreshToday();
    }).then(function () { btn.disabled = false; btn.textContent = "Kirim presensi sekaligus"; });
  });

  // ---------- helper hapus massal ----------
  function typeHapus(pesan) {
    if (!window.confirm(pesan)) return false;
    var t = window.prompt("Ketik HAPUS (huruf besar) untuk melanjutkan:");
    return t !== null && t.trim() === "HAPUS";
  }

  // ---------- DATA ----------
  var dsel = {}, drows = [];
  function dCount() { return Object.keys(dsel).length; }
  function dBar() {
    var n = dCount();
    $("d-del-sel").textContent = "Hapus terpilih (" + n + ")";
    $("d-del-sel").disabled = n === 0;
    $("d-del-all").disabled = drows.length === 0;
    $("d-all").disabled = drows.length === 0;
    $("d-all").checked = drows.length > 0 && n === drows.length;
    document.querySelectorAll("#d-list .ditem").forEach(function (it) { it.classList.toggle("sel", !!dsel[it.dataset.id]); });
  }
  function loadData() {
    var tgl = $("d-tanggal").value || todayWIB();
    var list = $("d-list"); list.innerHTML = ""; dsel = {}; drows = [];
    dBar();
    noteLoad("nd", tgl);
    sb.rpc("alasan_libur", { p_tanggal: tgl }).then(function (r) {
      var t = !r.error && typeof r.data === "string" ? r.data : "";
      $("d-libur").textContent = t ? "📅 " + t : ""; $("d-libur").hidden = !t;
    });
    sb.from("presensi").select("id,tanggal,jam,status,keterangan,siswa:siswa_id(nama,kelas)").eq("tanggal", tgl).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var rows = (r.data || []).slice().sort(function (a, b) { return (a.siswa.nama).toLowerCase() < (b.siswa.nama).toLowerCase() ? -1 : 1; });
      drows = rows;
      $("d-kosong").hidden = rows.length > 0;
      rows.forEach(function (x) {
        var it = el("div", "ditem"); it.dataset.id = x.id;
        var top = el("div", "top2");
        var lead = el("div", "lead");
        var cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("aria-label", "Pilih " + x.siswa.nama);
        cb.addEventListener("change", function () { if (cb.checked) dsel[x.id] = true; else delete dsel[x.id]; dBar(); });
        lead.appendChild(cb);
        var left = el("div");
        left.appendChild(el("div", "nm", x.siswa.nama));
        left.appendChild(el("div", "meta", x.siswa.kelas + " • " + hariTgl(x.tanggal) + " • " + String(x.jam).slice(0, 5)));
        lead.appendChild(left);
        top.appendChild(lead);
        top.appendChild(el("span", "badge " + kelasBadge(x.status), x.status));
        it.appendChild(top);
        if (x.status === "Izin" && x.keterangan) it.appendChild(el("div", "ketx", "Keterangan: " + x.keterangan));
        var act = el("div", "act");
        var be = el("button", "btn small", "Ubah"); be.type = "button";
        be.addEventListener("click", function () { openEdit(x); });
        var bd = el("button", "btn small danger", "Hapus"); bd.type = "button";
        bd.addEventListener("click", function () { hapus(x); });
        act.appendChild(be); act.appendChild(bd); it.appendChild(act);
        list.appendChild(it);
      });
      dBar();
    });
  }
  $("d-muat").addEventListener("click", loadData);
  $("d-tanggal").addEventListener("change", loadData);
  $("d-all").addEventListener("change", function () {
    var on = $("d-all").checked; dsel = {};
    document.querySelectorAll("#d-list .ditem").forEach(function (it) {
      var c = it.querySelector("input[type=checkbox]"); c.checked = on; if (on) dsel[it.dataset.id] = true;
    });
    dBar();
  });
  function afterDelete(r, okMsg) {
    if (r.error) notice(friendly(r.error), "err");
    else if (!r.data || !r.data.length) notice("Tidak ada data yang terhapus (tidak ada izin atau sudah hilang).", "err");
    else notice(r.data.length + " " + okMsg, "ok");
    loadData(); refreshToday();
  }
  $("d-del-sel").addEventListener("click", function () {
    var ids = Object.keys(dsel); if (!ids.length) return;
    if (!window.confirm("Hapus " + ids.length + " presensi yang dicentang? Tidak bisa dibatalkan.")) return;
    sb.from("presensi").delete().in("id", ids).select("id").then(function (r) { afterDelete(r, "presensi dihapus."); });
  });
  $("d-del-all").addEventListener("click", function () {
    if (!drows.length) return;
    var tgl = $("d-tanggal").value || todayWIB();
    if (!typeHapus("Hapus SEMUA " + drows.length + " presensi pada " + hariTgl(tgl) + "? Tidak bisa dibatalkan.")) return;
    sb.from("presensi").delete().eq("tanggal", tgl).select("id").then(function (r) { afterDelete(r, "presensi dihapus."); });
  });

  function hapus(x) {
    if (!window.confirm("Hapus presensi " + x.siswa.nama + " (" + x.status + ")? Tindakan ini tidak bisa dibatalkan.")) return;
    sb.from("presensi").delete().eq("id", x.id).select("id").then(function (r) {
      if (r.error) notice(friendly(r.error), "err");
      else if (!r.data || !r.data.length) notice("Data tidak terhapus (tidak ada izin atau sudah hilang).", "err");
      else notice("Presensi dihapus.", "ok");
      loadData(); refreshToday();
    });
  }

  // ---------- CATATAN HARI ----------
  function noteLoad(pre, date) {
    var ta = $(pre + "-text"); ta.value = "";
    if (pre === "nd") {
      var locked = state.role !== "developer" && date !== todayWIB();
      ta.disabled = locked; $("nd-save").disabled = locked; $("nd-del").disabled = locked;
      $("nd-info").textContent = locked ? "Hanya developer yang boleh mengubah catatan tanggal lain." : "";
    }
    return sb.from("catatan_hari").select("catatan").eq("tanggal", date).maybeSingle().then(function (r) {
      ta.value = r.data ? r.data.catatan : "";
      if (pre === "np") $("np-count").textContent = ta.value.length;
    });
  }
  function noteSave(pre, date, text, msg) {
    return sb.rpc("simpan_catatan", { p_tanggal: date, p_catatan: text }).then(function (r) {
      if (r.error) notice(friendly(r.error), "err"); else notice(msg, "ok");
      return noteLoad(pre, date);
    });
  }
  $("np-text").addEventListener("input", function () { $("np-count").textContent = $("np-text").value.length; });
  $("np-save").addEventListener("click", function () {
    var t = $("np-text").value.trim();
    if (!t) { notice("Tulis catatan dulu, atau pakai tombol Hapus catatan.", "err"); return; }
    noteSave("np", todayWIB(), t, "Catatan hari ini disimpan ✓");
  });
  $("np-del").addEventListener("click", function () {
    if (!window.confirm("Hapus catatan hari ini?")) return;
    noteSave("np", todayWIB(), "", "Catatan hari ini dihapus.");
  });
  $("nd-save").addEventListener("click", function () {
    var t = $("nd-text").value.trim();
    if (!t) { notice("Tulis catatan dulu, atau pakai tombol Hapus catatan.", "err"); return; }
    noteSave("nd", $("d-tanggal").value || todayWIB(), t, "Catatan disimpan ✓");
  });
  $("nd-del").addEventListener("click", function () {
    if (!window.confirm("Hapus catatan tanggal ini?")) return;
    noteSave("nd", $("d-tanggal").value || todayWIB(), "", "Catatan dihapus.");
  });

  // ---------- UBAH (dialog) ----------
  var dlg = $("editDlg");
  function toggleEditKet() { $("e-ket-wrap").hidden = $("e-status").value !== "Izin"; }
  $("e-status").addEventListener("change", toggleEditKet);
  function openEdit(x) {
    state.editing = x;
    $("e-nama").textContent = x.siswa.nama + " — " + x.siswa.kelas;
    $("e-status").value = x.status;
    $("e-ket").value = x.keterangan || "";
    toggleEditKet();
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
    var patch = { status: st, keterangan: null };
    if (st === "Izin") {
      var k = $("e-ket").value.trim();
      if (!k) { notice("Isi keterangan izin dulu.", "err"); dlg.close(); return; }
      patch.keterangan = k;
    }
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
  var msel = {}, mrows = [];
  function mBar() {
    var n = Object.keys(msel).length;
    $("m-del-sel").textContent = "Hapus terpilih (" + n + ")";
    $("m-del-sel").disabled = n === 0;
    $("m-del-all").disabled = mrows.length === 0;
    $("m-all").disabled = mrows.length === 0;
    $("m-all").checked = mrows.length > 0 && n === mrows.length;
  }
  function loadMonitor() {
    var body = $("m-body"); body.innerHTML = ""; msel = {}; mrows = []; mBar();
    sb.from("log_login").select("id,waktu,email,role,event,ip,perangkat").order("waktu", { ascending: false }).limit(100).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var label = { login: "Masuk", logout: "Keluar", timeout: "Keluar otomatis" };
      mrows = r.data || [];
      mrows.forEach(function (x) {
        var tr = el("tr");
        var tc = el("td", "cb");
        var cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.id = x.id; cb.setAttribute("aria-label", "Pilih log");
        cb.addEventListener("change", function () { if (cb.checked) msel[x.id] = true; else delete msel[x.id]; mBar(); });
        tc.appendChild(cb); tr.appendChild(tc);
        [waktuWIB(x.waktu), x.email || "-", x.role || "-", label[x.event] || x.event, x.ip || "-"].forEach(function (v) { tr.appendChild(el("td", "", v)); });
        var ua = el("td", "ua", x.perangkat || "-"); ua.title = x.perangkat || ""; tr.appendChild(ua);
        body.appendChild(tr);
      });
      mBar();
    });
  }
  $("m-muat").addEventListener("click", loadMonitor);
  $("m-all").addEventListener("change", function () {
    var on = $("m-all").checked; msel = {};
    document.querySelectorAll("#m-body input[type=checkbox]").forEach(function (c) { c.checked = on; if (on) msel[c.dataset.id] = true; });
    mBar();
  });
  function afterLogDelete(r) {
    if (r.error) notice(friendly(r.error), "err");
    else if (!r.data || !r.data.length) notice("Tidak ada log yang terhapus.", "err");
    else notice(r.data.length + " catatan log dihapus.", "ok");
    loadMonitor();
  }
  $("m-del-sel").addEventListener("click", function () {
    var ids = Object.keys(msel).map(Number); if (!ids.length) return;
    if (!window.confirm("Hapus " + ids.length + " catatan log yang dicentang?")) return;
    sb.from("log_login").delete().in("id", ids).select("id").then(afterLogDelete);
  });
  $("m-del-all").addEventListener("click", function () {
    if (!mrows.length) return;
    if (!typeHapus("Hapus SEMUA catatan log login (termasuk yang tidak terlihat di daftar ini)? Tidak bisa dibatalkan.")) return;
    sb.from("log_login").delete().gt("id", 0).select("id").then(afterLogDelete);
  });

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
  $("i-durasi").addEventListener("change", function () { $("i-custom-wrap").hidden = $("i-durasi").value !== "custom"; });
  var DUR = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3, "3d": 3 * 86400e3, "7d": 7 * 86400e3 };

  function hitungBerakhir() {                 // null = tidak pernah hilang; false = tidak valid
    var d = $("i-durasi").value;
    if (d === "never") return null;
    if (DUR[d]) return new Date(Date.now() + DUR[d]).toISOString();
    var v = $("i-custom").value;              // "2026-11-20T15:30" dianggap WIB
    if (!v) return false;
    var t = new Date(v + ":00+07:00");
    if (isNaN(t) || t.getTime() <= Date.now()) return false;
    return t.toISOString();
  }
  $("i-kirim").addEventListener("click", function () {
    var t = $("i-text").value.trim();
    if (!t) { notice("Tulis isi info dulu.", "err"); return; }
    var akhir = hitungBerakhir();
    if (akhir === false) { notice("Pilih waktu hilang yang valid (harus di masa depan).", "err"); return; }
    var btn = $("i-kirim"); btn.disabled = true;
    sb.rpc("tulis_info", { p_pesan: t, p_berakhir: akhir }).then(function (r) {
      btn.disabled = false;
      if (r.error) { notice(friendly(r.error), "err"); return; }
      $("i-text").value = ""; $("i-count").textContent = "0"; $("i-durasi").value = "never"; $("i-custom-wrap").hidden = true; $("i-custom").value = "";
      notice("Banner info ditampilkan ✓", "ok"); loadBanner(); loadInfoList();
    });
  });

  function loadInfoList() {
    var list = $("i-list"); list.innerHTML = "";
    sb.from("info_web").select("id,pesan,aktif,berakhir_pada,dibuat_pada").order("dibuat_pada", { ascending: false }).limit(10).then(function (r) {
      if (r.error) { notice(friendly(r.error), "err"); return; }
      var rows = r.data || [];
      $("i-kosong").hidden = rows.length > 0;
      rows.forEach(function (x) {
        var expired = x.berakhir_pada && new Date(x.berakhir_pada).getTime() <= Date.now();
        var tampil = x.aktif && !expired;
        var it = el("div", "iitem");
        it.appendChild(el("div", "it", x.pesan));
        it.appendChild(el("span", "badge st " + (tampil ? "tampil" : expired && x.aktif ? "habis" : "off"), tampil ? "Sedang tampil" : (x.aktif && expired ? "Sudah berakhir" : "Dihentikan")));
        it.appendChild(el("div", "meta", "Dibuat " + waktuWIB(x.dibuat_pada) + " • " + (x.berakhir_pada ? "Hilang " + waktuWIB(x.berakhir_pada) : "Tidak pernah hilang")));
        var act = el("div", "act");
        if (tampil) {
          var bs = el("button", "btn small", "Stop info"); bs.type = "button";
          bs.addEventListener("click", function () {
            if (!window.confirm("Hentikan info ini? Banner akan hilang tapi info tetap ada di daftar.")) return;
            sb.rpc("stop_info", { p_id: x.id }).then(function (r2) {
              if (r2.error) notice(friendly(r2.error), "err"); else notice("Info dihentikan (hilang dari banner).", "ok");
              loadBanner(); loadInfoList();
            });
          });
          act.appendChild(bs);
        }
        if (!tampil) {
          var bj = el("button", "btn small primary", "Jalankan info"); bj.type = "button";
          bj.addEventListener("click", function () {
            var pesan = expired
              ? "Waktu hilang info ini sudah lewat. Jalankan lagi TANPA batas waktu (tidak pernah hilang)?"
              : "Jalankan info ini lagi? Info yang sedang tampil (jika ada) akan digantikan.";
            if (!window.confirm(pesan)) return;
            sb.rpc("jalankan_info", { p_id: x.id }).then(function (r2) {
              if (r2.error) notice(friendly(r2.error), "err"); else notice("Info dijalankan, banner tampil lagi ✓", "ok");
              loadBanner(); loadInfoList();
            });
          });
          act.appendChild(bj);
        }
        var bd = el("button", "btn small danger", "Hapus info"); bd.type = "button";
        bd.addEventListener("click", function () {
          if (!window.confirm("Hapus info ini secara permanen?")) return;
          sb.rpc("hapus_info", { p_id: x.id }).then(function (r2) {
            if (r2.error) notice(friendly(r2.error), "err"); else notice("Info dihapus.", "ok");
            loadBanner(); loadInfoList();
          });
        });
        act.appendChild(bd);
        it.appendChild(act);
        list.appendChild(it);
      });
    });
  }
  $("i-muat").addEventListener("click", loadInfoList);

  // ---------- MULAI ----------
  mountSingleChips();
  sb.auth.getSession().then(function (r) {
    if (r.data && r.data.session) {
      if (idleExpired()) {                                // sesi lama + sudah lewat 30 menit -> wajib login ulang
        sb.auth.signOut().then(function () { showLogin(); showTimeoutMsg(); });
        return;
      }
      loadRole().then(function (role) { if (role) enterApp(role); else { sb.auth.signOut(); showLogin(); } });
    } else {
      showLogin();
    }
  });
})();
