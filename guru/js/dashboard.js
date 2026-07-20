/**
 * @file guru/js/dashboard.js
 * Dashboard utama Portal Guru — 1 login, tab Guru + tab Jabatan.
 */

import { applyBrandingById, getLoginUrl } from '../../shared/branding.js';
import { checkMustChangePassword, initChangePassword } from '../../shared/change-password.js';
import { initLoginGuard } from '../../shared/login-guard.js';
import {
    supabase, logout, getCurrentUserRow, GURU_ROLES,
    listSchoolAdmins, addSchoolAdmin, removeSchoolAdmin,
    getJabatan, jabatanLabel, getSchoolConfig,
    getMyScheduleForDate, getEnrolledStudents, getMyClasses,
    getAttendanceForSession,
    getMyStudents, searchStudents, insertObservation,
    getWaliKelasInfo, getWaliAttendanceSummary,
    getProgram,
    getAttendanceSummaryByStudents,

    getSchoolStats, getKepsekMonitoring,
    getPendingAttendanceSessions, getPendingSessionsByTeacher, getPendingSessionsDetail,
    getAttendanceFillRate,
    getAttendanceRecapPerClass, getOpenCases,
    getPrograms, getStudentAttendanceSessions,
    getJournalEntries, insertJournalEntry, deleteJournalEntry, updateJournalEntry,
    getMyObservations, getStudentUserId, getStudentParents,
    getCases, getCase, getCaseEvents, createCase,
    addCaseComment, escalateCase, changeCaseStatus, closeCase,
    updateCaseAudience, logCaseAudienceChange, getCaseAudienceMembers,
    addCaseAudienceMember, removeCaseAudienceMember, searchInternalUsers,
    getUnreadNotifCount, getRecentNotifications, markNotificationsRead,
    registerLoginDevice,
    getForumPosts, getForumCategories, getForumStudents, createForumPost,
    addForumAcknowledgement, addForumComment, getForumPostComments, getForumClasses,
    withdrawForumPost, updateForumPost, withdrawForumComment, getForumMemberDetails,
    getCorePhases, getCoreSubjectsDirect,
    getMyTeacherDocuments, createTeacherDocument,
    updateDocumentStatus, deleteTeacherDocument, getPendingDocApprovals, wakaApproveDoc,
    getKepsekApprovalHistory, getWakaApprovalHistory, getDisahkanWakaDocs,
    getTeacherProfile, saveTeacherProfile,
    getTeachingContext, saveTeachingContext,
} from './api.js';
import { saveAttendanceBatch, flushPending, pendingCount, clearOfflineQueue } from './offline.js';

// ─── Notifikasi lonceng ───────────────────────────────────────
// Menggantikan badge localStorage. Sumber kebenaran = tabel notifications.

let _notifPollTimer = null;

function _setBellBadge(n) {
    const btn = document.getElementById('notif-bell-btn');
    if (!btn) return;
    let badge = btn.querySelector('.notif-badge-count');
    if (n > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'notif-badge-count';
            badge.className = 'notif-badge-count';
            btn.style.position = 'relative';
            btn.appendChild(badge);
        }
        badge.textContent = n > 99 ? '99+' : String(n);
    } else {
        badge?.remove();
    }
}

async function refreshNotifBadge() {
    if (!currentUser) return;
    try {
        const n = await getUnreadNotifCount();
        _setBellBadge(n);
    } catch { /* tidak kritis */ }
}

function startNotifPolling() {
    clearInterval(_notifPollTimer);
    _notifPollTimer = setInterval(refreshNotifBadge, 60_000); // poll tiap 1 menit
}

async function openNotifDropdown() {
    const panel = document.getElementById('notif-dropdown');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (isOpen) { panel.style.display = 'none'; return; }

    panel.style.display = 'block';
    panel.innerHTML = '<p style="padding:12px;font-size:13px;color:var(--color-text-muted)">Memuat…</p>';
    try {
        const notifs = await getRecentNotifications(15);
        if (!notifs.length) {
            panel.innerHTML = '<p style="padding:12px;font-size:13px;color:var(--color-text-muted)">Tidak ada notifikasi baru.</p>';
            return;
        }
        panel.innerHTML = notifs.map(n => `
            <div class="notif-item" data-id="${n.notification_id}" data-case="${n.case_id ?? ''}"
                 style="padding:10px 14px;border-bottom:1px solid var(--color-border);cursor:pointer;font-size:13px">
                <div style="font-weight:600;margin-bottom:2px">${esc(n.title)}</div>
                <div style="color:var(--color-text-muted);font-size:12px">${esc(n.body)}</div>
                <div style="color:var(--color-text-muted);font-size:11px;margin-top:3px">${fmt(n.created_at)}</div>
            </div>`).join('') +
            `<div style="padding:8px 14px;text-align:center">
                <button id="notif-mark-all-btn" class="btn btn-secondary btn-sm" style="font-size:12px">Tandai semua dibaca</button>
            </div>`;

        panel.querySelectorAll('.notif-item').forEach(el => {
            el.addEventListener('mouseenter', () => { el.style.background = 'var(--color-bg)'; });
            el.addEventListener('mouseleave', () => { el.style.background = ''; });
            el.addEventListener('click', async () => {
                panel.style.display = 'none';
                await markNotificationsRead([el.dataset.id]).catch(() => {});
                await refreshNotifBadge();
                if (el.dataset.case) openKasusDetail(el.dataset.case);
            });
        });

        document.getElementById('notif-mark-all-btn')?.addEventListener('click', async () => {
            const ids = notifs.map(n => n.notification_id);
            await markNotificationsRead(ids).catch(() => {});
            panel.style.display = 'none';
            _setBellBadge(0);
        });
    } catch {
        panel.innerHTML = '<p style="padding:12px;font-size:13px;color:var(--color-danger)">Gagal memuat notifikasi.</p>';
    }
}

function markKasusAsSeen() {
    // Tidak lagi pakai localStorage — mark read via DB saat buka kasus
    _setBellBadge(0);
}

// ─── State ───────────────────────────────────────────────────
let currentUser  = null;
const _studentSubjectCache = new Map(); // studentId → { userId, parents }
let config       = null;   // { current_academic_year, current_semester }
let jabatan      = [];
let isTeacher    = false;  // hanya GURU & WALI_KELAS yang mengajar
let myStudents         = [];     // for observation selector
let isBroadObserver    = false;  // BK/Waka/Kepsek — bisa cari siswa seluruh sekolah
let _studentPoolInit   = false;  // guard: ensureStudentPool hanya load sekali

const DIMENSION_LABELS = { AKADEMIK:'Akademik', KEHADIRAN:'Kehadiran', PERILAKU:'Perilaku', SOSIAL:'Sosial', AFEKTIF:'Afektif', BAKAT_MINAT:'Bakat & Minat', FISIK:'Fisik', LAINNYA:'Lainnya' };

// ─── Read cache (LF-2) ───────────────────────────────────────
// Simpan snapshot data server ke localStorage → tampilkan saat halaman
// dibuka (sebelum server merespons), termasuk saat offline.
const LC = {
    set(key, data) {
        try { localStorage.setItem(`smkhr:${key}`, JSON.stringify({ ts: Date.now(), data })); } catch {}
    },
    get(key) {
        try { const r = JSON.parse(localStorage.getItem(`smkhr:${key}`)); return r?.data ?? null; }
        catch { return null; }
    },
    clear(prefix) {
        try { Object.keys(localStorage).filter(k => k.startsWith(`smkhr:${prefix}`)).forEach(k => localStorage.removeItem(k)); }
        catch {}
    },
    remove(key) {
        try { localStorage.removeItem(`smkhr:${key}`); } catch {}
    },
};

function esc(s) {
    const el = document.createElement('span');
    el.textContent = s ?? '';
    return el.innerHTML;
}
/** Pesan error ramah pengguna — detail teknis ke console saja. */
function fe(err, ctx = 'muat') {
    console.error('[guru]', err);
    const m = String(err?.message ?? '').toLowerCase();
    if (m.includes('jwt') || m.includes('expired')) return 'Sesi habis. Silakan login ulang.';
    if (m.includes('fetch') || m.includes('network') || m.includes('failed to fetch')) return 'Tidak ada koneksi. Periksa jaringan.';
    if (m.includes('security policy') || m.includes('permission') || m.includes('forbidden')) return 'Tidak memiliki izin.';
    return ctx === 's' ? 'Gagal menyimpan. Silakan coba lagi.'
         : ctx === 'h' ? 'Gagal menghapus. Silakan coba lagi.'
         : 'Gagal memuat data. Silakan coba lagi.';
}
function fmt(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('id-ID', { day:'numeric', month:'short', year:'numeric' });
}
function fmtTime(t) { return t ? t.slice(0, 5) : '—'; }

// ─── Boot ────────────────────────────────────────────────────
async function init() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth?.user) { window.location.replace(getLoginUrl()); return; }

    currentUser = await getCurrentUserRow(auth.user);
    if (!currentUser || !GURU_ROLES.includes(currentUser.role_type) || currentUser.is_active === false) {
        await supabase.auth.signOut();
        window.location.replace(getLoginUrl());
        return;
    }

    await Promise.all([
        applyBrandingById(currentUser.school_id, supabase),
        checkMustChangePassword(supabase, currentUser),
        initLoginGuard(supabase, currentUser),
        getSchoolConfig().then(c => { config = c; }),
    ]);
    if (!config) throw new Error('School config tidak tersedia. Hubungi admin sekolah.');
    jabatan   = getJabatan(currentUser);
    isTeacher = !!currentUser.teacher_code
        || (currentUser.teaching_assignments?.[0]?.count ?? 0) > 0;

    // Header
    document.getElementById('hdr-name').textContent = currentUser.full_name;
    const roleLabel = jabatan.length
        ? (isTeacher ? 'Guru' : '') +
          (isTeacher && jabatan.length ? ' · ' : '') +
          jabatan.map(jabatanLabel).join(' · ')
        : 'Guru';
    document.getElementById('hdr-role').textContent = roleLabel;

    buildTabs();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display     = 'block';

    const defaultTab = isTeacher ? 'guru' : (jabatan[0] ?? 'kasus');
    activateTab(defaultTab);
    await loadTabContent(defaultTab);

    // Offline sync: tampilkan status + kirim absensi tertunda.
    await updateSyncBanner();
    window.addEventListener('online',  runFlush);
    window.addEventListener('offline', updateSyncBanner);
    runFlush();

    // Peringatan login dari perangkat baru: daftarkan perangkat ini.
    // Jika belum pernah dipakai (bukan yg pertama), server menaruh notif
    // di lonceng. Non-blocking; kegagalan tak mengganggu dashboard.
    await registerLoginDevice();

    // Notifikasi: cek unread count lalu poll tiap 1 menit.
    refreshNotifBadge();
    startNotifPolling();

    initPWAInstallBanner();
}

function initPWAInstallBanner() {
    if (!sessionStorage.getItem('pwa_show_install_banner')) return;
    sessionStorage.removeItem('pwa_show_install_banner');

    if (localStorage.getItem('pwa_install_dismissed')) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    if (isStandalone) return;

    const banner = document.getElementById('pwa-install-banner');
    if (!banner) return;
    banner.style.display = 'flex';

    const autoHide = setTimeout(() => { banner.style.display = 'none'; }, 10000);

    document.getElementById('pwa-install-btn')?.addEventListener('click', () => {
        clearTimeout(autoHide);
        banner.style.display = 'none';
        localStorage.setItem('pwa_install_dismissed', '1');
        showPWAInstallInstructions();
    });

    document.getElementById('pwa-dismiss-btn')?.addEventListener('click', () => {
        clearTimeout(autoHide);
        banner.style.display = 'none';
    });
}

function showPWAInstallInstructions() {
    const isIOS     = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);

    let steps = '';
    if (isIOS) {
        steps = `<li>Tap tombol <strong>Bagikan</strong> (□↑) di Safari</li>
                 <li>Scroll ke bawah, tap <strong>"Tambahkan ke Layar Utama"</strong></li>
                 <li>Tap <strong>Tambahkan</strong></li>`;
    } else if (isAndroid) {
        steps = `<li>Tap menu <strong>⋮</strong> di Chrome</li>
                 <li>Tap <strong>"Tambahkan ke layar utama"</strong></li>
                 <li>Tap <strong>Tambahkan</strong></li>`;
    } else {
        steps = `<li>Klik ikon <strong>Install</strong> (⊕) di address bar browser</li>
                 <li>Klik <strong>Install</strong></li>`;
    }

    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);
                  z-index:9999;display:flex;align-items:center;
                  justify-content:center;padding:16px">
        <div style="background:var(--color-surface,#1e293b);border-radius:16px;
                    padding:24px;max-width:360px;width:100%;color:var(--color-text,#fff)">
          <h3 style="margin:0 0 16px;font-size:18px">📱 Pasang Aplikasi SIP</h3>
          <ol style="margin:0;padding-left:20px;line-height:1.8">${steps}</ol>
          <button onclick="this.closest('div[style]').remove()"
                  style="margin-top:16px;width:100%;padding:10px;
                         background:var(--color-primary,#1d4ed8);color:white;
                         border:none;border-radius:8px;cursor:pointer;font-size:14px">
            Mengerti
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

// ─── Tab navigation ──────────────────────────────────────────
const TAB_SHORT = {
    guru: 'Beranda', wali_kelas: 'Wali', bk: 'BK',
    waka_kesiswaan: 'Kesiswaan', waka_kurikulum: 'Kurikulum', waka_humas: 'Humas',
    kepsek: 'Kepsek', ks_admin: 'Admin',
    kasus: 'Pembinaan', jurnal: 'Jurnal', observasi: 'Catatan', forum: 'Forum',
    perangkat_ajar: 'Perangkat',
};
const TAB_ICON = {
    guru: 'ti-home', wali_kelas: 'ti-users', bk: 'ti-heart-handshake',
    waka_kesiswaan: 'ti-school', waka_kurikulum: 'ti-book', waka_humas: 'ti-building-community',
    kepsek: 'ti-chart-line', ks_admin: 'ti-shield-check',
    kasus: 'ti-alert-triangle', jurnal: 'ti-notebook', observasi: 'ti-notes', forum: 'ti-messages',
    perangkat_ajar: 'ti-book-2',
};

function buildTabs() {
    const nav    = document.getElementById('tab-nav');
    const botNav = document.getElementById('bottom-nav');
    const tabs = [];
    if (isTeacher) tabs.push({ key: 'guru', label: 'Dashboard Guru' });
    jabatan.forEach(j => tabs.push({ key: j, label: jabatanLabel(j) }));
    tabs.push({ key: 'kasus', label: 'Pembinaan Siswa' });
    if (jabatan.includes('kepsek')) tabs.push({ key: 'ks_admin', label: 'Kelola Admin' });
    if (isTeacher) tabs.push({ key: 'observasi', label: 'Catatan Siswa' });
    if (isTeacher) tabs.push({ key: 'jurnal', label: 'Jurnal Mengajar' });
    if (isTeacher) tabs.push({ key: 'perangkat_ajar', label: 'Perangkat Ajar' });
    tabs.push({ key: 'forum', label: 'Forum Kelas' });

    nav.innerHTML = tabs.map(t =>
        `<button class="tab-btn" data-tab="${t.key}">${esc(t.label)}</button>`
    ).join('');

    botNav.innerHTML = `<div class="bottom-nav-inner">${
        tabs.map(t => {
            const icon = TAB_ICON[t.key] ?? 'ti-circle';
            return `<button class="tab-btn" data-tab="${t.key}"><i class="ti ${icon} nav-icon" aria-hidden="true"></i>${esc(TAB_SHORT[t.key] ?? t.label)}</button>`;
        }).join('')
    }</div>`;

    const handler = async (e) => {
        const key = e.target.closest('[data-tab]')?.dataset?.tab;
        if (!key) return;
        activateTab(key);
        await loadTabContent(key);
    };
    nav.addEventListener('click', handler);
    botNav.addEventListener('click', handler);
}

function activateTab(key) {
    document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === key));
    document.querySelectorAll('.tab-panel').forEach(p =>
        p.classList.toggle('active', p.id === `tab-${key}`));
}

async function loadTabContent(key) {
    try {
        switch (key) {
            case 'guru':        await initGuruTab(); break;
            case 'wali_kelas':  await initWaliTab(); break;
            case 'bk':          await initBkTab(); break;
            case 'waka_kesiswaan': await initWakaKesiswaanTab(); break;
            case 'waka_kurikulum': await initWakaKurTab(); break;
            case 'waka_humas':  await initWakaHumasTab(); break;
            case 'kepsek':      await initKepsekTab(); break;
            case 'ks_admin':    await initKsAdminTab(); break;
            case 'kasus':       await initKasusTab(); break;
            case 'jurnal':      await initJurnalTab(); break;
            case 'observasi':   await initObsTab(); break;
            case 'perangkat_ajar': await initPerangkatAjarTab(); break;
            case 'forum':       await initForumTab(); break;
        }
    } catch (err) {
        console.error('[loadTabContent]', key, err);
        const activePanel = document.querySelector('.tab-panel.active .page-body');
        if (activePanel) {
            activePanel.innerHTML = '<p style="padding:1.5rem; color:red">Gagal memuat tab ini. Silakan coba lagi atau refresh halaman.</p>';
        }
    }
}

// ─── TAB GURU ────────────────────────────────────────────────

let _guruTabInit     = false;
let _guruRekapRows      = [];
let _guruRekapPage      = 0;
let _guruRekapDateStart = null;
let _guruRekapDateEnd   = null;
let _guruRekapClassName = null;
async function initGuruTab() {
    const dateEl = document.getElementById('sched-date');
    if (!dateEl.value) dateEl.value = localDateStr();

    if (!_guruTabInit) {
        _guruTabInit = true;
        const recapBtn = document.getElementById('guru-recap-btn');
        recapBtn.addEventListener('click', async () => {
            const content = document.getElementById('guru-recap-content');
            if (recapBtn.textContent.trim() === 'Sembunyikan') {
                content.style.display = 'none';
                recapBtn.textContent = 'Tampilkan';
                return;
            }
            content.style.display = '';
            await loadGuruRecap();
        });
        // Default rentang: awal bulan ini s/d hari ini
        const today = localDateStr();
        const firstOfMonth = today.slice(0, 8) + '01';
        document.getElementById('guru-recap-start').value = firstOfMonth;
        document.getElementById('guru-recap-end').value   = today;
        await initGuruRekapDropdown();

        // Toggle hari / minggu — auto-load saat switch
        document.querySelectorAll('.sched-view-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                document.querySelectorAll('.sched-view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const isWeek = btn.dataset.view === 'minggu';
                document.getElementById('sched-view-hari-panel').style.display  = isWeek ? 'none' : 'block';
                document.getElementById('sched-view-minggu-panel').style.display = isWeek ? 'block' : 'none';
                if (isWeek) await loadWeekSchedule();
                else await loadSchedule();
            });
        });
    }

    await loadSchedule();
    await initObsForm();
}

async function initGuruRekapDropdown() {
    const sel = document.getElementById('guru-recap-class');
    try {
        const classes = await getMyClasses(currentUser.user_id, config.current_academic_year, config.current_semester);

        if (classes.length === 0) {
            sel.innerHTML = '<option value="">Tidak ada kelas</option>';
            return;
        }
        sel.innerHTML = '<option value="">— Pilih Kelas —</option>' +
            classes.map(c => `<option value="${c.class_id}">${esc(c.name)}</option>`).join('');
    } catch {
        sel.innerHTML = '<option value="">Gagal memuat kelas</option>';
    }
}

function renderGuruRekapPage() {
    const container = document.getElementById('guru-rekap-accordion');
    if (!container) return;

    const STATUS_COLOR = {
        HADIR: 'var(--color-success)',
        IZIN:  'var(--color-warning,#f59e0b)',
        SAKIT: 'var(--color-primary)',
        ALPA:  'var(--color-danger)',
    };
    const STATUS_LABEL = { HADIR:'Hadir', IZIN:'Izin', SAKIT:'Sakit', ALPA:'Alpa' };

    container.innerHTML = _guruRekapRows
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'))
        .map(s => {
            const pct   = s.total > 0 ? Math.round(s.HADIR / s.total * 100) : null;
            const color = pct === null ? 'var(--color-text-muted)' : pct >= 80 ? 'var(--color-success)' : pct >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
            return `
            <details class="att-accordion" style="margin-bottom:6px"
                     data-student-id="${esc(s.student_id)}"
                     data-date-start="${esc(_guruRekapDateStart ?? '')}"
                     data-date-end="${esc(_guruRekapDateEnd ?? '')}">
                <summary class="att-accordion-summary">
                    <span class="att-acc-name">
                        ${esc(s.full_name)}
                    </span>
                    <span style="display:flex;gap:10px;align-items:center;font-size:11px;font-weight:500">
                        <span>${s.HADIR}H · ${s.IZIN}I · ${s.SAKIT}S · ${s.ALPA}A</span>
                        <span style="color:${color};font-weight:600">${pct !== null ? pct + '%' : '—'}</span>
                    </span>
                </summary>
                <div style="padding:4px 0">
                    <p class="acc-empty">Memuat sesi…</p>
                </div>
            </details>`;
        }).join('');

    container.querySelectorAll('details[data-student-id]').forEach(det => {
        det.addEventListener('toggle', async () => {
            if (!det.open) return;
            const body = det.querySelector('div');
            if (!body || body.dataset.loaded) return;
            body.dataset.loaded = '1';
            const sid = det.dataset.studentId;
            const ds  = det.dataset.dateStart || null;
            const de  = det.dataset.dateEnd   || null;
            if (!ds || !de) {
                body.innerHTML = '<p class="acc-empty">Pilih rentang tanggal untuk melihat detail sesi. Untuk data lengkap, gunakan fitur Unduh Excel.</p>';
                return;
            }
            try {
                const sessions = await getStudentAttendanceSessions(sid, ds, de, currentUser.user_id);
                if (!sessions.length) {
                    body.innerHTML = '<p class="acc-empty">Belum ada sesi tercatat.</p>';
                    return;
                }
                body.innerHTML = sessions.map(s => `
                    <div style="display:flex;align-items:center;gap:8px;
                        padding:7px 16px;border-top:0.5px solid var(--color-border)">
                        <span style="font-size:12px;color:var(--color-text-muted);min-width:90px">
                            ${esc(s.schedule.session_date)} ${fmtTime(s.schedule.session_start)}
                        </span>
                        <span style="flex:1;font-size:12px;color:var(--color-text-muted)">
                            ${esc(s.schedule.subject?.name ?? '—')}
                        </span>
                        <span style="font-size:11px;font-weight:600;
                            color:${STATUS_COLOR[s.status] ?? 'var(--color-text-muted)'}">
                            ${STATUS_LABEL[s.status] ?? esc(s.status)}
                        </span>
                    </div>`).join('');
            } catch(err) {
                body.innerHTML = `<div class="alert alert-danger" style="margin:8px 16px">${esc(fe(err))}</div>`;
            }
        });
    });
}

async function loadGuruRecap() {
    const classId   = document.getElementById('guru-recap-class').value;
    const dateStart = document.getElementById('guru-recap-start').value;
    const dateEnd   = document.getElementById('guru-recap-end').value;
    const content   = document.getElementById('guru-recap-content');
    const className = document.getElementById('guru-recap-class').selectedOptions[0]?.text ?? '';

    if (!classId) { content.innerHTML = '<p class="hint">Pilih kelas terlebih dahulu.</p>'; return; }

    content.innerHTML = '<p class="hint">Memuat rekap…</p>';
    try {
        const enrolled = await getEnrolledStudents(classId, config.current_academic_year);
        if (enrolled.length === 0) {
            content.innerHTML = '<p class="hint">Belum ada siswa aktif di kelas ini untuk tahun ajaran ini.</p>';
            return;
        }
        const rows = await getAttendanceSummaryByStudents(classId, config.current_academic_year, dateStart || null, dateEnd || null, currentUser.user_id);

        _guruRekapRows      = rows;
        _guruRekapPage      = 0;
        _guruRekapDateStart = dateStart || null;
        _guruRekapDateEnd   = dateEnd   || null;
        _guruRekapClassName = className;

        content.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
                <p style="font-size:0.82rem;color:var(--color-text-muted);margin:0">
                    ${esc(className)} · ${rows.length} siswa · akumulasi ${dateStart || '—'} s/d ${dateEnd || '—'}
                </p>
                <button class="btn btn-secondary btn-sm" id="guru-recap-export">Unduh Excel</button>
            </div>
            <div id="guru-rekap-accordion"></div>`;

        document.getElementById('guru-recap-export').addEventListener('click', () => {
            const rows = _guruRekapRows;
            if (!rows.length) return;

            const wsData = [
                ['Nama', 'Hadir', 'Izin', 'Sakit', 'Alpa', 'Total Sesi', '% Hadir'],
                ...rows.map(s => {
                    const tot = s.HADIR + s.IZIN + s.SAKIT + s.ALPA;
                    const pct = tot > 0 ? Math.round(s.HADIR / tot * 100) : 0;
                    return [s.full_name, s.HADIR, s.IZIN, s.SAKIT, s.ALPA, s.total, tot > 0 ? pct + '%' : '—'];
                })
            ];

            const ws = XLSX.utils.aoa_to_sheet(wsData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Rekap Kehadiran');
            const start = document.getElementById('guru-recap-start').value;
            const end   = document.getElementById('guru-recap-end').value;
            XLSX.writeFile(wb, `kehadiran_${_guruRekapClassName ?? 'kelas'}_${start}_${end}.xlsx`);
        });

        renderGuruRekapPage();
        document.getElementById('guru-recap-btn').textContent = 'Sembunyikan';
    } catch (err) {
        content.innerHTML = `<div class="status-err">Gagal memuat rekap. ${esc(fe(err))}</div>`;
    }
}

function localDateStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDayLabel(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function isConsecutive(endTime, startTime) {
    const toMin = t => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
    return toMin(startTime) - toMin(endTime) <= 40;
}

function mergeConsecutiveSessions(sessions) {
    const sorted = [...sessions].sort((a, b) => a.session_start.localeCompare(b.session_start));
    const merged = [];
    for (const s of sorted) {
        const last = merged[merged.length - 1];
        const sameBlock = last
            && last.class?.class_id === s.class?.class_id
            && isConsecutive(last.merged_end, s.session_start);
        if (sameBlock) {
            last.merged_end = s.session_end;
            last.schedule_ids.push(s.schedule_id);
        } else {
            merged.push({
                ...s,
                merged_start: s.session_start,
                merged_end:   s.session_end,
                schedule_ids: [s.schedule_id],
            });
        }
    }
    return merged;
}

function renderScheduleRows(rows, contentEl, date) {
    const today     = localDateStr();
    const isToday   = date === today;
    const label     = fmtDayLabel(date);
    const sesiCount = rows.length;
    const now       = new Date();
    const nowTime   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const mergedRows = mergeConsecutiveSessions(rows);
    const tableHtml = sesiCount === 0
        ? '<p class="hint" style="margin:8px 0 4px">Tidak ada jadwal mengajar pada tanggal ini.</p>'
        : `<div class="table-wrapper">
           <table class="table">
               <thead><tr><th>Jam</th><th>Kelas</th><th>Kehadiran</th></tr></thead>
               <tbody>
               ${mergedRows.map(r => {
                   const ended = date < today || (isToday && nowTime > r.merged_end);
                   return `
                   <tr>
                       <td>${fmtTime(r.merged_start)} – ${fmtTime(r.merged_end)}</td>
                       <td>${esc(r.class?.name ?? '—')}</td>
                       <td>
                           <button class="btn btn-secondary btn-xs att-open-btn"
                               data-schedule="${r.schedule_ids[0]}"
                               data-schedule-ids='${JSON.stringify(r.schedule_ids)}'
                               data-class="${r.class?.class_id}"
                               data-classname="${esc(r.class?.name ?? '')}"
                               data-ispast="${ended}"
                               ${ended ? 'disabled title="Sesi sudah berakhir — tidak dapat diubah"' : 'style="background:var(--color-primary);color:#fff;border-color:var(--color-primary)"'}>
                               ${ended ? 'Sesi Berakhir' : 'Input Kehadiran'}
                           </button>
                       </td>
                   </tr>`;
               }).join('')}
               </tbody>
           </table>
           </div>`;

    contentEl.innerHTML = `
        <details class="att-accordion" ${isToday || sesiCount > 0 ? 'open' : ''}>
            <summary class="att-accordion-summary">
                <span class="att-acc-name">${esc(label)}</span>
                <span class="att-acc-names">${sesiCount > 0 ? `${sesiCount} sesi` : 'tidak ada jadwal'}</span>
            </summary>
            <div style="padding:0 12px 8px">${tableHtml}</div>
        </details>`;

    contentEl.querySelectorAll('.att-open-btn').forEach(btn => {
        btn.addEventListener('click', () => openAttModal(btn));
    });
    document.getElementById('att-modal-close').onclick = closeAttModal;
    document.getElementById('att-modal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeAttModal();
    });
}

function openAttModal(btn) {
    const modal    = document.getElementById('att-modal');
    const isPast   = btn.dataset.ispast === 'true';
    document.getElementById('att-modal-title').textContent =
        isPast ? `Koreksi Kehadiran — ${btn.dataset.classname}` : `Kehadiran — ${btn.dataset.classname}`;
    document.getElementById('att-modal-body').innerHTML =
        (isPast ? '<p class="hint" style="background:var(--color-bg-alt);padding:8px 10px;border-radius:6px;margin-bottom:12px">Data kehadiran sebelumnya sudah ditampilkan. Ubah jika perlu lalu klik Simpan.</p>' : '') +
        '<p class="hint">Memuat daftar siswa…</p>';
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    loadAttModalContent(btn.dataset.schedule, btn.dataset.class, btn.dataset.classname);
}

function closeAttModal() {
    document.getElementById('att-modal').style.display = 'none';
    document.body.style.overflow = '';
}

async function loadSchedule() {
    const date      = document.getElementById('sched-date').value;
    const contentEl = document.getElementById('sched-content');
    const cacheKey  = `sched-${currentUser.user_id}-${date}`;

    // Tampilkan cache dulu — halaman langsung berisi data walau offline
    const cached = LC.get(cacheKey);
    if (cached) {
        renderScheduleRows(cached, contentEl, date);
    } else {
        contentEl.innerHTML = '<p class="hint">Memuat jadwal…</p>';
    }

    try {
        const rows = await getMyScheduleForDate(currentUser.user_id, date);
        LC.set(cacheKey, rows);
        renderScheduleRows(rows, contentEl, date);
    } catch (err) {
        if (!cached) {
            contentEl.innerHTML = `<div class="status-err">Gagal memuat data. ${esc(fe(err))}</div>`;
        }
        // Jika ada cache, biarkan data lama tetap tampil — jangan overwrite dengan error
    }
}

async function loadWeekSchedule() {
    const contentEl = document.getElementById('sched-week-content');
    contentEl.innerHTML = '<p class="hint">Memuat jadwal minggu ini…</p>';

    // Hitung Senin s/d Jumat minggu ini
    const today = new Date();
    const dow   = today.getDay(); // 0=Min,1=Sen,...,6=Sab
    const diff  = dow === 0 ? -6 : 1 - dow; // hari ke Senin
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);

    const days = Array.from({ length: 5 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        return localDateStr(d);
    });

    try {
        const results = await Promise.all(
            days.map(d => getMyScheduleForDate(currentUser.user_id, d)
                .then(rows => ({ date: d, rows }))
                .catch(() => ({ date: d, rows: [] }))
            )
        );

        const hasAny = results.some(r => r.rows.length > 0);
        if (!hasAny) {
            contentEl.innerHTML = '<p class="hint">Tidak ada jadwal mengajar minggu ini.</p>';
            return;
        }

        const DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
        const todayStr  = localDateStr();
        contentEl.innerHTML = results.map((r, idx) => {
            const dayLabel  = `${DAY_NAMES[idx]}, ${fmtDayLabel(r.date).split(',')[1]?.trim() ?? r.date}`;
            const isToday   = r.date === todayStr;
            const mergedSessions = mergeConsecutiveSessions(r.rows);
            const sesiCount = mergedSessions.length;
            const tableHtml = sesiCount === 0
                ? '<p class="hint" style="margin:8px 0 4px">Tidak ada jadwal</p>'
                : `<div class="table-wrapper">
                   <table class="table">
                       <thead><tr><th>Jam</th><th>Kelas</th></tr></thead>
                       <tbody>${mergedSessions.map(s => `
                           <tr>
                               <td>${fmtTime(s.merged_start)} – ${fmtTime(s.merged_end)}</td>
                               <td>${esc(s.class?.name ?? '—')}</td>
                           </tr>`).join('')}
                       </tbody>
                   </table>
                   </div>`;

            return `
                <details class="att-accordion">
                    <summary class="att-accordion-summary">
                        <span class="att-acc-name">${esc(dayLabel)}</span>
                        <span class="att-acc-names">${sesiCount > 0 ? `${sesiCount} sesi` : 'tidak ada jadwal'}</span>
                    </summary>
                    <div style="padding:0 12px 8px">${tableHtml}</div>
                </details>`;
        }).join('');

        // Single-expand: tutup semua accordion lain saat satu dibuka
        contentEl.querySelectorAll('details.att-accordion').forEach(det => {
            det.addEventListener('toggle', () => {
                if (det.open) {
                    contentEl.querySelectorAll('details.att-accordion').forEach(other => {
                        if (other !== det) other.removeAttribute('open');
                    });
                }
            });
        });

        contentEl.querySelectorAll('.att-open-btn').forEach(btn => {
            btn.addEventListener('click', () => openAttModal(btn));
        });
    } catch (err) {
        contentEl.innerHTML = `<div class="status-err">Gagal memuat. ${esc(fe(err))}</div>`;
    }
}

async function loadAttModalContent(scheduleId, classId, className) {
    const panel = document.getElementById('att-modal-body');

    try {
        const [students, existing] = await Promise.all([
            getEnrolledStudents(classId, config.current_academic_year),
            getAttendanceForSession(scheduleId),
        ]);

        if (students.length === 0) {
            panel.innerHTML = '<p class="hint">Tidak ada siswa terdaftar di kelas ini.</p>';
            return;
        }

        const statuses = ['HADIR','IZIN','SAKIT','ALPA'];
        const statusLabel = { HADIR:'Hadir', IZIN:'Izin', SAKIT:'Sakit', ALPA:'Alpa' };

        function renderStudentRow(s) {
            const cur      = existing.get(s.student_id)?.status ?? 'HADIR';
            const curNotes = existing.get(s.student_id)?.notes  ?? '';
            const radios   = statuses.map(st => `
                <label class="att-radio-label">
                    <input type="radio" name="att_${scheduleId}_${s.student_id}"
                           value="${st}" ${cur === st ? 'checked' : ''}
                           onchange="document.getElementById('notes_${scheduleId}_${s.student_id}').style.display=this.value==='IZIN'?'block':'none'">
                    ${statusLabel[st]}
                </label>`).join('');
            return `
                <div class="att-row">
                    <div class="att-name">
                        ${esc(s.full_name)}
                    </div>
                    <div class="att-radio-group">${radios}</div>
                    <input type="text" id="notes_${scheduleId}_${s.student_id}"
                           class="input att-notes-input"
                           placeholder="Alasan izin (opsional)…"
                           value="${esc(curNotes)}"
                           style="display:${cur === 'IZIN' ? 'block' : 'none'}; margin-top:4px; width:100%; font-size:0.85em">
                </div>`;
        }

        // Carousel per-5-siswa
        const CHUNK = 5;
        const chunks = [];
        for (let i = 0; i < students.length; i += CHUNK)
            chunks.push(students.slice(i, i + CHUNK));

        const slidesHtml = chunks.map(group => `
            <div class="att-carousel-slide">${group.map(renderStudentRow).join('')}</div>`).join('');

        const lastChunkEnd = students.length;
        panel.innerHTML = `
            <div class="att-carousel-nav">
                <button class="att-prev" aria-label="Sebelumnya">&#8592;</button>
                <div class="att-carousel-counter">
                    Siswa <span class="att-cur-range">1–${Math.min(CHUNK, students.length)}</span> / ${students.length}
                </div>
                <button class="att-next" aria-label="Berikutnya">&#8594;</button>
            </div>
            <div class="att-carousel-track-wrap">
                <div class="att-carousel-track">${slidesHtml}</div>
            </div>
            <div class="att-save-btn">
                <button class="btn btn-success btn-sm att-save" data-schedule="${scheduleId}" data-count="${students.length}">
                    Simpan Kehadiran (${students.length} siswa)
                </button>
                <span class="status-msg" id="att-status-${scheduleId}" style="display:none; margin-left:8px"></span>
            </div>`;

        // Carousel logic
        let cur = 0;
        const track    = panel.querySelector('.att-carousel-track');
        const curRange = panel.querySelector('.att-cur-range');
        const prevBtn  = panel.querySelector('.att-prev');
        const nextBtn  = panel.querySelector('.att-next');

        function goTo(idx) {
            cur = Math.max(0, Math.min(chunks.length - 1, idx));
            track.style.transform = `translateX(-${cur * 100}%)`;
            const start = cur * CHUNK + 1;
            const end   = Math.min(start + CHUNK - 1, students.length);
            curRange.textContent = `${start}–${end}`;
            prevBtn.disabled = cur === 0;
            nextBtn.disabled = cur === chunks.length - 1;
        }
        goTo(0);
        prevBtn.addEventListener('click', () => goTo(cur - 1));
        nextBtn.addEventListener('click', () => goTo(cur + 1));

        // Touch swipe
        let tx0 = null;
        track.parentElement.addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; }, { passive: true });
        track.parentElement.addEventListener('touchend', e => {
            if (tx0 === null) return;
            const dx = e.changedTouches[0].clientX - tx0;
            if (Math.abs(dx) > 40) goTo(dx < 0 ? cur + 1 : cur - 1);
            tx0 = null;
        }, { passive: true });

        const scheduleIds = (() => { try { return JSON.parse(document.querySelector(`.att-open-btn[data-schedule="${scheduleId}"]`)?.dataset?.scheduleIds ?? 'null'); } catch { return null; } })() ?? [scheduleId];
        panel.querySelector('.att-save').addEventListener('click', () => saveAttendance(scheduleIds, students));
    } catch (err) {
        panel.innerHTML = `<div class="status-err">Gagal memuat data. ${esc(fe(err))}</div>`;
    }
}

async function saveAttendance(scheduleIds, students) {
    const scheduleId = Array.isArray(scheduleIds) ? scheduleIds[0] : scheduleIds;
    const allIds     = Array.isArray(scheduleIds) ? scheduleIds : [scheduleIds];
    const saveBtn  = document.querySelector(`.att-save[data-schedule="${scheduleId}"]`);
    const statusEl = document.getElementById(`att-status-${scheduleId}`);
    saveBtn.disabled = true;
    saveBtn.textContent = 'Menyimpan…';
    statusEl.style.display = 'none';

    try {
        const records = students.map(s => {
            const checked = document.querySelector(`input[name="att_${scheduleId}_${s.student_id}"]:checked`);
            const status  = checked?.value ?? 'HADIR';
            const notesEl = document.getElementById(`notes_${scheduleId}_${s.student_id}`);
            const notes   = status === 'IZIN' ? (notesEl?.value.trim() || null) : null;
            return { student_id: s.student_id, status, source: 'TEACHER_DECLARED', notes };
        });

        const sessionDate = document.getElementById('sched-date').value;
        const results = await Promise.all(allIds.map(sid => saveAttendanceBatch({
            idempotency_key: crypto.randomUUID(),
            schedule_id:     sid,
            submitted_by:    currentUser.user_id,
            session_date:    sessionDate,
            records,
        })));

        const anyQueued = results.some(r => r.status === 'queued');
        const anyFailed = results.find(r => r.status !== 'synced' && r.status !== 'queued');
        if (anyFailed) {
            statusEl.textContent = `✗ ${anyFailed.error}`;
            statusEl.className   = 'status-msg status-err';
            statusEl.style.display = 'inline-block';
            await updateSyncBanner();
        } else if (anyQueued) {
            statusEl.textContent = `⏳ Tersimpan di perangkat — menunggu sinkron (${records.length} siswa × ${allIds.length} sesi)`;
            statusEl.className   = 'status-msg status-warn';
            statusEl.style.display = 'inline-block';
            await updateSyncBanner();
            setTimeout(() => closeAttModal(), 1800);
        } else {
            statusEl.textContent = `✓ Tersimpan — ${records.length} siswa × ${allIds.length} sesi`;
            statusEl.className   = 'status-msg status-ok';
            statusEl.style.display = 'inline-block';
            await updateSyncBanner();
            setTimeout(() => closeAttModal(), 1200);
        }
    } catch (err) {
        statusEl.textContent = `✗ ${fe(err, 's')}`;
        statusEl.className   = 'status-msg status-err';
        statusEl.style.display = 'inline-block';
    } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = `Simpan Kehadiran (${students.length} siswa)`;
    }
}

// ── Sinkronisasi offline: indikator + flush ───────────────────

async function updateSyncBanner() {
    let el = document.getElementById('sync-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'sync-banner';
        el.className = 'sync-banner';
        document.body.appendChild(el);
    }
    let n = 0;
    try { n = await pendingCount(); } catch (_) { n = 0; }
    if (n > 0) {
        el.textContent = navigator.onLine
            ? `⏳ ${n} item menunggu sinkron — menyinkronkan…`
            : `⏳ ${n} item tersimpan di perangkat — akan terkirim saat online`;
        el.style.display = 'block';
    } else {
        el.style.display = 'none';
    }
}

function showSessionExpiredBanner() {
    let el = document.getElementById('sync-banner');
    if (!el) return;
    el.style.background  = 'var(--color-danger-bg,#fef2f2)';
    el.style.color       = 'var(--color-danger,#dc2626)';
    el.style.borderColor = 'var(--color-danger,#dc2626)';
    el.textContent       = '⚠️ Sesi habis — antrian offline ditahan. Login ulang untuk melanjutkan sinkronisasi.';
    el.style.display     = 'block';
}

async function runFlush() {
    try {
        const { synced, remaining, sessionExpired } = await flushPending();
        if (synced > 0) console.log(`[offline] ${synced} item tersinkron`);
        if (sessionExpired) { showSessionExpiredBanner(); return remaining; }
        await updateSyncBanner();
        return remaining;
    } catch (e) { console.warn('[offline] flush gagal:', e); }
}

// ── Student pool (dipakai Observasi & Kasus) ─────────────────

async function ensureStudentPool() {
    if (_studentPoolInit) return;
    _studentPoolInit = true;
    isBroadObserver = jabatan.some(j => ['bk', 'waka_kesiswaan', 'kepsek'].includes(j));
    const stuCacheKey = `mystudents-${currentUser.user_id}`;
    myStudents = LC.get(stuCacheKey) ?? [];
    try {
        const fresh = await getMyStudents(
            currentUser.user_id,
            config.current_academic_year,
            config.current_semester
        );
        myStudents = fresh;
        LC.set(stuCacheKey, fresh);
    } catch (_) { /* pakai cache yang sudah di-load di atas */ }
}

// ── Observasi ─────────────────────────────────────────────────

let _obsFormInit = false;
async function initObsForm() {
    if (_obsFormInit) return;
    _obsFormInit = true;
    await ensureStudentPool();

    const searchEl      = document.getElementById('obs-student-search');
    const hiddenEl      = document.getElementById('obs-student-id');
    const listEl        = document.getElementById('obs-student-list');
    const form          = document.getElementById('obs-form');
    const submitBtn     = document.getElementById('obs-submit');
    const statusEl      = document.getElementById('obs-status');
    const obsContentEl  = document.getElementById('obs-content');
    const obsCharCountEl= document.getElementById('obs-char-count');
    const visSelect     = document.getElementById('obs-visibility');
    obsContentEl.addEventListener('input', () => {
        obsCharCountEl.textContent = obsContentEl.value.length;
    });

    // Audience ditentukan oleh select obs-visibility — tidak ada picker.

    function renderHits(hits) {
        if (hits.length === 0) { listEl.style.display = 'none'; return; }
        listEl.innerHTML = hits.map(s =>
            `<div class="obs-list-item" data-id="${s.student_id}" data-name="${esc(s.full_name)}"
                style="padding:10px 14px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--color-border)">
                ${esc(s.full_name)} <span style="color:var(--color-text-muted)">${esc(s.nis ?? '')}${s.class_name ? ' · ' + esc(s.class_name) : ''}</span>
            </div>`
        ).join('');
        listEl.style.display = 'block';
        listEl.querySelectorAll('.obs-list-item').forEach(item => {
            item.addEventListener('mousedown', () => {
                hiddenEl.value       = item.dataset.id;
                searchEl.value       = item.dataset.name;
                listEl.style.display = 'none';
            });
        });
    }

    searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        if (q.length < 2) { listEl.style.display = 'none'; return; }
        const hits = myStudents.filter(s =>
            s.full_name.toLowerCase().includes(q) || s.nis?.includes(q)
        );
        renderHits(hits.slice(0, 10));
    });
    document.addEventListener('click', (e) => {
        if (!listEl.contains(e.target) && e.target !== searchEl) listEl.style.display = 'none';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!hiddenEl.value) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--color-danger)';
            statusEl.textContent = 'Pilih siswa terlebih dahulu.';
            return;
        }
        const visibility = visSelect.value;
        statusEl.style.display = 'none';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Menyimpan…';
        try {
            const r = await insertObservation({
                authorId:   currentUser.user_id,
                studentId:  hiddenEl.value,
                dimension:  document.getElementById('obs-dimension').value,
                sentiment:  document.getElementById('obs-sentiment').value,
                visibility,
                content:    document.getElementById('obs-content').value,
            });
            if (r.status === 'error') throw new Error(r.error);
            statusEl.textContent = r.status === 'queued'
                ? '⏳ Catatan disimpan lokal — akan dikirim saat online.'
                : '✓ Catatan berhasil disimpan.';
            statusEl.className = 'status-msg status-ok';
            statusEl.style.display = 'block';
            form.reset();
            hiddenEl.value = '';
            if (r.status === 'synced') await loadObsHistory();
        } catch (err) {
            statusEl.textContent   = `✗ ${fe(err, 's')}`;
            statusEl.className     = 'status-msg status-err';
            statusEl.style.display = 'block';
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Simpan Catatan';
        }
    });
}

async function initObsTab() {
    await initObsForm();
    await loadObsHistory();
}

async function loadObsHistory() {
    const listEl   = document.getElementById('obs-history-list');
    const cacheKey = `obs-history-${currentUser.user_id}`;
    const cached   = LC.get(cacheKey);
    if (cached) renderObsHistory(cached, listEl);
    else listEl.innerHTML = '<p class="hint">Memuat…</p>';
    try {
        const rows = await getMyObservations(currentUser.user_id);
        LC.set(cacheKey, rows);
        renderObsHistory(rows, listEl);
    } catch (err) {
        if (!cached) listEl.innerHTML = `<div class="status-err">Gagal memuat. ${esc(fe(err))}</div>`;
    }
}

const DIMENSION_LABELS_OBS = { AKADEMIK:'Akademik', KEHADIRAN:'Kehadiran', PERILAKU:'Perilaku', SOSIAL:'Sosial', AFEKTIF:'Afektif', BAKAT_MINAT:'Bakat & Minat', FISIK:'Fisik', LAINNYA:'Lainnya' };
const SENTIMENT_LABELS = { POSITIF:'Positif', NETRAL:'Netral', NEGATIF:'Perlu Perhatian' };
const SENTIMENT_COLOR  = { POSITIF:'var(--color-success)', NETRAL:'var(--color-text-muted)', NEGATIF:'var(--color-danger)' };

const OBS_VIS_LABEL = {
    SISWA_SAJA:    '🎓 Siswa saja',
    ORTU_SAJA:     '👨‍👩‍👧 Orang Tua saja',
    SISWA_DAN_ORTU:'👨‍👩‍👦 Siswa & Orang Tua',
};

function renderObsHistory(rows, listEl) {
    if (!rows.length) {
        listEl.innerHTML = '<p class="hint">Belum ada catatan yang ditulis.</p>';
        return;
    }
    listEl.innerHTML = rows.map(r => {
        const nama      = r.student?.full_name ?? '—';
        const nis       = r.student?.nis ? ` · ${r.student.nis}` : '';
        const dim       = DIMENSION_LABELS_OBS[r.dimension] ?? r.dimension;
        const sent      = SENTIMENT_LABELS[r.sentiment]  ?? r.sentiment;
        const sentColor = SENTIMENT_COLOR[r.sentiment] ?? 'inherit';
        const vis      = r.visibility ?? 'SISWA_DAN_ORTU';
        const visLabel = OBS_VIS_LABEL[vis] ?? vis;
        const visColor  = 'var(--color-primary)';
        const isVoid    = !!r.is_void;
        const voidStyle = isVoid ? 'opacity:0.55;' : '';
        return `
        <div data-obs-id="${esc(r.observation_id)}" data-obs-vis="${esc(vis)}"
             data-student-id="${esc(r.student_id ?? '')}"
             data-author-id="${esc(r.author_user_id ?? '')}"
             data-student-name="${esc(r.student?.full_name ?? '')}"
             style="border-bottom:0.5px solid var(--color-border);padding:10px 0;font-size:13px;${voidStyle}">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:4px">
                <strong>${esc(nama)}<span style="font-weight:400;color:var(--color-text-muted)">${esc(nis)}</span></strong>
                <span style="font-size:11px;color:var(--color-text-muted)">${fmt(r.observed_at)}</span>
            </div>
            ${isVoid ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;color:var(--color-danger)">
                <span>⊘ Disembunyikan oleh admin</span>
                ${r.void_reason ? `<span style="color:var(--color-text-muted)">— ${esc(r.void_reason)}</span>` : ''}
            </div>` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center">
                <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:var(--color-bg-alt)">${esc(dim)}</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:20px;color:${sentColor};background:var(--color-bg-alt)">${esc(sent)}</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:20px;color:${visColor};background:var(--color-bg-alt)">${visLabel}</span>
            </div>
            <p style="margin:0 0 6px;white-space:pre-wrap;color:var(--color-text)">${esc(r.content)}</p>
        </div>`;
    }).join('');

}

// ─── TAB WALI KELAS ──────────────────────────────────────────

async function initWaliTab() {
    const classId = currentUser.wali_kelas_class_id;
    if (!classId) return;

    const info = await getWaliKelasInfo(classId);
    document.getElementById('wali-class-title').textContent =
        `Kelas Walian — ${info?.name ?? ''}`;

    const today    = localDateStr();
    const monthAgo = localDateStr(new Date(Date.now() - 30 * 86400000));
    document.getElementById('wali-date-start').value = monthAgo;
    document.getElementById('wali-date-end').value   = today;

    document.getElementById('wali-filter-btn').onclick = loadWaliSummary;

    document.getElementById('wali-recap-export').onclick = async () => {
        const btn = document.getElementById('wali-recap-export');
        btn.disabled = true;
        btn.textContent = 'Menyiapkan…';

        try {
            const classId   = currentUser.wali_kelas_class_id;
            const dateStart = document.getElementById('wali-date-start').value;
            const dateEnd   = document.getElementById('wali-date-end').value;

            const students = await getWaliAttendanceSummary(classId, config.current_academic_year, dateStart, dateEnd);

            const allSessions = await Promise.all(
                students.map(s => getStudentAttendanceSessions(s.student_id, dateStart, dateEnd)
                    .then(sessions => ({ student: s, sessions }))
                )
            );

            const wb = XLSX.utils.book_new();

            const summaryData = [
                ['Nama', 'Hadir', 'Izin', 'Sakit', 'Alpa', 'Total Sesi', '% Hadir'],
                ...students.map(s => {
                    const tot = s.HADIR + s.IZIN + s.SAKIT + s.ALPA;
                    const pct = tot > 0 ? Math.round(s.HADIR / tot * 100) : 0;
                    return [s.full_name, s.HADIR, s.IZIN, s.SAKIT, s.ALPA, s.total,
                            tot > 0 ? pct + '%' : '—'];
                })
            ];
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Ringkasan');

            for (const { student, sessions } of allSessions) {
                const sheetData = [
                    ['Tanggal', 'Jam', 'Mata Pelajaran', 'Guru', 'Status'],
                    ...sessions.map(s => [
                        s.schedule?.session_date ?? '',
                        s.schedule?.session_start ? fmtTime(s.schedule.session_start) : '',
                        s.schedule?.subject?.name ?? '',
                        s.schedule?.teacher?.full_name ?? '',
                        s.status ?? '',
                    ])
                ];
                const sheetName = student.full_name.slice(0, 31);
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), sheetName);
            }

            const className = document.getElementById('wali-class-title')
                .textContent.replace('Kelas Walian — ', '').trim();
            XLSX.writeFile(wb, `rekap_wali_${className}_${dateStart}_${dateEnd}.xlsx`);

        } catch (err) {
            alert('Gagal mengunduh: ' + fe(err));
        } finally {
            btn.disabled = false;
            btn.textContent = 'Unduh Excel';
        }
    };

    await loadWaliSummary();
}

async function loadWaliSummary() {
    const classId   = currentUser.wali_kelas_class_id;
    const dateStart = document.getElementById('wali-date-start').value || null;
    const dateEnd   = document.getElementById('wali-date-end').value   || null;
    const container = document.getElementById('wali-att-recap');
    container.innerHTML = '<p class="hint">Memuat…</p>';

    try {
        const students = await getWaliAttendanceSummary(
            classId, config.current_academic_year, dateStart, dateEnd
        );
        if (!students.length) {
            container.innerHTML = '<p class="hint">Belum ada siswa di kelas ini.</p>';
            return;
        }

        container.innerHTML = buildAttStatCards(students) + students
            .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'))
            .map(s => {
                const pct   = s.total > 0 ? Math.round(s.HADIR / s.total * 100) : null;
                const color = pct === null ? 'var(--color-text-muted)' : pct >= 80 ? 'var(--color-success)' : pct >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
                return `
                <details class="att-accordion" style="margin-bottom:6px"
                         data-student-id="${esc(s.student_id)}"
                         data-date-start="${esc(dateStart ?? '')}"
                         data-date-end="${esc(dateEnd ?? '')}">
                    <summary class="att-accordion-summary">
                        <span class="att-acc-name">
                            ${esc(s.full_name)}
                        </span>
                        <span class="att-acc-status" style="color:${color};font-weight:600">
                            ${pct !== null ? pct + '%' : '—'}
                        </span>
                    </summary>
                    <div style="padding:4px 0">
                        <p class="acc-empty">Memuat sesi…</p>
                    </div>
                </details>`;
            }).join('');

        // Lazy load sesi per siswa
        container.querySelectorAll('details[data-student-id]').forEach(det => {
            det.addEventListener('toggle', async () => {
                if (!det.open) return;
                const body = det.querySelector('div');
                if (!body || body.dataset.loaded) return;
                body.dataset.loaded = '1';
                const sid = det.dataset.studentId;
                const ds  = det.dataset.dateStart || null;
                const de  = det.dataset.dateEnd   || null;
                if (!ds || !de) {
                    body.innerHTML = '<p class="acc-empty">Pilih rentang tanggal untuk melihat detail sesi. Untuk data lengkap, gunakan fitur Unduh Excel.</p>';
                    return;
                }
                try {
                    const sessions = await getStudentAttendanceSessions(sid, ds, de);
                    if (!sessions.length) {
                        body.innerHTML = '<p class="acc-empty">Belum ada sesi tercatat.</p>';
                        return;
                    }
                    const STATUS_COLOR = {
                        HADIR: 'var(--color-success)',
                        IZIN:  'var(--color-warning,#f59e0b)',
                        SAKIT: 'var(--color-primary)',
                        ALPA: 'var(--color-danger)',
                    };
                    const STATUS_LABEL = { HADIR:'Hadir', IZIN:'Izin', SAKIT:'Sakit', ALPA:'Alpa' };
                    body.innerHTML = sessions.map(s => `
                        <div style="display:flex;align-items:center;gap:8px;
                            padding:7px 16px;border-top:0.5px solid var(--color-border)">
                            <span style="font-size:12px;color:var(--color-text-muted);min-width:90px">
                                ${esc(s.schedule.session_date)} ${fmtTime(s.schedule.session_start)}
                            </span>
                            <span style="flex:1;font-size:12px;color:var(--color-text-muted)">
                                ${esc(s.schedule.subject?.name ?? '—')} · ${esc(s.schedule.teacher?.full_name ?? '—')}
                            </span>
                            <span style="font-size:11px;font-weight:600;
                                color:${STATUS_COLOR[s.status] ?? 'var(--color-text-muted)'}">
                                ${STATUS_LABEL[s.status] ?? esc(s.status)}
                            </span>
                        </div>`).join('');
                } catch(err) {
                    body.innerHTML = `<div class="alert alert-danger" style="margin:8px 16px">${esc(fe(err))}</div>`;
                }
            });
        });

        document.getElementById('wali-recap-export').style.display = '';

    } catch (err) {
        container.innerHTML = `<div class="alert alert-danger">${esc(fe(err))}</div>`;
    }
}

// ─── TAB BK ──────────────────────────────────────────────────

async function initBkTab() {
    const today        = localDateStr();
    const firstOfMonth = today.slice(0, 8) + '01';
    document.getElementById('bk-att-start').value = firstOfMonth;
    document.getElementById('bk-att-end').value   = today;
    document.getElementById('bk-att-filter-btn').onclick = loadBkAttendanceRecap;
    await loadBkAttendanceRecap();
}

async function loadBkAttendanceRecap() {
    const dateStart = document.getElementById('bk-att-start').value || null;
    const dateEnd   = document.getElementById('bk-att-end').value   || null;
    const container = document.getElementById('bk-att-recap');
    container.innerHTML = '<p class="hint">Memuat…</p>';
    try {
        const [programs, rows] = await Promise.all([
            getPrograms(),
            getAttendanceRecapPerClass(dateStart, dateEnd),
        ]);

        if (!rows.length) {
            container.innerHTML = '<p class="hint">Belum ada data kehadiran.</p>';
            return;
        }

        const classMap = new Map(rows.map(r => [r.class_id, r]));
        const progMap  = new Map();
        for (const prog of programs) progMap.set(prog.program_id, { ...prog, classes: [] });

        const { data: classProgData, error: cpErr } = await supabase
            .from('classes')
            .select('class_id, program_id')
            .in('class_id', rows.map(r => r.class_id));
        if (cpErr) throw cpErr;

        for (const cp of classProgData ?? []) {
            const prog = progMap.get(cp.program_id);
            const cls  = classMap.get(cp.class_id);
            if (prog && cls) prog.classes.push(cls);
        }

        const activeProgs = [...progMap.values()].filter(p => p.classes.length > 0);

        const html = activeProgs.map(prog => {
            const classAccordions = prog.classes
                .sort((a, b) => a.name.localeCompare(b.name, 'id'))
                .map(r => {
                    const tot  = r.HADIR + r.IZIN + r.SAKIT + r.ALPA;
                    const pctH = tot > 0 ? Math.round(r.HADIR       / tot * 100) : 0;
                    const pctI = tot > 0 ? Math.round(r.IZIN        / tot * 100) : 0;
                    const pctS = tot > 0 ? Math.round(r.SAKIT       / tot * 100) : 0;
                    const pctA = tot > 0 ? Math.round(r.ALPA / tot * 100) : 0;
                    const colH = pctH >= 80 ? 'var(--color-success)' : pctH >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
                    return `
                    <details class="att-accordion wz-accordion-inner" style="margin:4px 0 4px 16px">
                        <summary class="att-accordion-summary">
                            <span class="att-acc-name">${esc(r.name)}</span>
                            <span class="att-acc-names" style="display:flex;gap:10px;font-size:11px;font-weight:500">
                                <span style="color:${colH}">${pctH}%H</span>
                                <span style="color:var(--color-warning,#f59e0b)">${pctI}%I</span>
                                <span style="color:var(--color-primary)">${pctS}%S</span>
                                <span style="color:var(--color-danger)">${pctA}%A</span>
                            </span>
                        </summary>
                        <div data-class-id="${esc(r.class_id)}"
                             data-date-start="${esc(dateStart ?? '')}"
                             data-date-end="${esc(dateEnd ?? '')}"
                             style="padding:4px 0">
                            <p class="hint" style="padding:8px 16px">Memuat siswa…</p>
                        </div>
                    </details>`;
                }).join('');

            return `
            <details class="att-accordion" style="margin-bottom:8px">
                <summary class="att-accordion-summary">
                    <span>${esc(prog.name)}</span>
                    <span class="att-acc-names">${prog.classes.length} kelas</span>
                </summary>
                <div style="padding:4px 0">${classAccordions}</div>
            </details>`;
        }).join('');

        container.innerHTML = buildAttStatCards(rows) + html;

        container.querySelectorAll('details.wz-accordion-inner').forEach(det => {
            det.addEventListener('toggle', async () => {
                if (!det.open) return;
                const body = det.querySelector('[data-class-id]');
                if (!body || body.dataset.loaded) return;
                body.dataset.loaded = '1';
                const classId = body.dataset.classId;
                const dStart  = body.dataset.dateStart || null;
                const dEnd    = body.dataset.dateEnd   || null;
                try {
                    const students = await getWaliAttendanceSummary(
                        classId, config.current_academic_year, dStart, dEnd
                    );
                    if (!students.length) {
                        body.innerHTML = '<p class="hint" style="padding:8px 16px">Belum ada data kehadiran siswa.</p>';
                        return;
                    }
                    body.innerHTML = students
                        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'))
                        .map(s => {
                            const pct   = s.total > 0 ? Math.round(s.HADIR / s.total * 100) : null;
                            const color = pct === null ? 'var(--color-text-muted)' : pct >= 80 ? 'var(--color-success)' : pct >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
                            return `
                            <details class="att-accordion wz-accordion-inner"
                                     style="margin:4px 8px 4px 24px"
                                     data-student-id="${esc(s.student_id)}"
                                     data-date-start="${esc(dStart ?? '')}"
                                     data-date-end="${esc(dEnd ?? '')}">
                                <summary class="att-accordion-summary">
                                    <span class="att-acc-name">
                                        ${esc(s.full_name)}
                                        <span class="sub-label" style="margin-left:4px">${esc(s.nis)}</span>
                                    </span>
                                    <span style="color:${color};font-weight:600">
                                        ${pct !== null ? pct + '%' : '—'}
                                    </span>
                                </summary>
                                <div style="padding:4px 0">
                                    <p class="hint" style="padding:8px 24px">Memuat sesi…</p>
                                </div>
                            </details>`;
                        }).join('');

                    body.querySelectorAll('details[data-student-id]').forEach(stuDet => {
                        stuDet.addEventListener('toggle', async () => {
                            if (!stuDet.open) return;
                            const sBody = stuDet.querySelector('div');
                            if (!sBody || sBody.dataset.loaded) return;
                            sBody.dataset.loaded = '1';
                            const sid = stuDet.dataset.studentId;
                            const ds  = stuDet.dataset.dateStart || null;
                            const de  = stuDet.dataset.dateEnd   || null;
                            if (!ds || !de) {
                                sBody.innerHTML = '<p class="hint" style="padding:8px 24px">Pilih rentang tanggal untuk melihat detail sesi. Untuk data lengkap, gunakan fitur Unduh Excel.</p>';
                                return;
                            }
                            try {
                                const sessions = await getStudentAttendanceSessions(sid, ds, de);
                                if (!sessions.length) {
                                    sBody.innerHTML = '<p class="hint" style="padding:8px 24px">Belum ada sesi tercatat.</p>';
                                    return;
                                }
                                const STATUS_COLOR = {
                                    HADIR: 'var(--color-success)',
                                    IZIN:  'var(--color-warning,#f59e0b)',
                                    SAKIT: 'var(--color-primary)',
                                    ALPA: 'var(--color-danger)',
                                };
                                const STATUS_LABEL = { HADIR: 'Hadir', IZIN: 'Izin', SAKIT: 'Sakit', ALPA: 'Alpa' };
                                sBody.innerHTML = sessions.map(s => `
                                    <div style="display:flex;align-items:center;gap:8px;
                                        padding:7px 24px;border-top:0.5px solid var(--color-border)">
                                        <span style="font-size:12px;color:var(--color-text-muted);min-width:90px">
                                            ${esc(s.schedule.session_date)} ${fmtTime(s.schedule.session_start)}
                                        </span>
                                        <span style="flex:1;font-size:12px;color:var(--color-text-muted)">
                                            ${esc(s.schedule.subject?.name ?? '—')} · ${esc(s.schedule.teacher?.full_name ?? '—')}
                                        </span>
                                        <span style="font-size:11px;font-weight:600;
                                            color:${STATUS_COLOR[s.status] ?? 'var(--color-text-muted)'}">
                                            ${STATUS_LABEL[s.status] ?? esc(s.status)}
                                        </span>
                                    </div>`).join('');
                            } catch(err) {
                                sBody.innerHTML = `<div class="alert alert-danger" style="margin:8px 24px">${esc(fe(err))}</div>`;
                            }
                        });
                    });
                } catch (err) {
                    body.innerHTML = `<div class="alert alert-danger" style="margin:8px 16px">${esc(fe(err))}</div>`;
                }
            });
        });

    } catch (err) {
        container.innerHTML = `<div class="alert alert-danger">${esc(fe(err))}</div>`;
    }
}

// ─── TAB WAKA KESISWAAN ──────────────────────────────────────

async function initWakaKesiswaanTab() {
    const today        = localDateStr();
    const firstOfMonth = today.slice(0, 8) + '01';
    document.getElementById('wk-att-start').value = firstOfMonth;
    document.getElementById('wk-att-end').value   = today;
    document.getElementById('wk-att-filter-btn').onclick = loadWkAttendanceRecap;

    await loadWkAttendanceRecap();
}

function buildAttStatCards(rows) {
    const tot  = rows.reduce((s,r) => s + r.HADIR + r.IZIN + r.SAKIT + r.ALPA, 0);
    const h    = rows.reduce((s,r) => s + r.HADIR,       0);
    const i    = rows.reduce((s,r) => s + r.IZIN,        0);
    const sk   = rows.reduce((s,r) => s + r.SAKIT,       0);
    const a    = rows.reduce((s,r) => s + r.ALPA, 0);
    const pctH = tot > 0 ? Math.round(h  / tot * 100) : 0;
    const pctI = tot > 0 ? Math.round(i  / tot * 100) : 0;
    const pctS = tot > 0 ? Math.round(sk / tot * 100) : 0;
    const pctA = tot > 0 ? Math.round(a  / tot * 100) : 0;
    const muted = 'var(--color-text-muted)';
    const colH = tot === 0 ? muted : pctH >= 80 ? 'var(--color-success)' : pctH >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
    const colI = tot === 0 ? muted : 'var(--color-warning,#f59e0b)';
    const colS = tot === 0 ? muted : 'var(--color-primary)';
    const colA = tot === 0 ? muted : 'var(--color-danger)';
    const lbl  = 'font-size:11px;color:var(--color-text-muted);margin-top:2px';
    return `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px">
        <div style="background:var(--color-bg);border:0.5px solid var(--color-border);border-radius:var(--radius);padding:10px;text-align:center">
            <div style="font-size:20px;font-weight:500;color:${colH}">${pctH}%</div>
            <div style="${lbl}">Hadir</div>
        </div>
        <div style="background:var(--color-bg);border:0.5px solid var(--color-border);border-radius:var(--radius);padding:10px;text-align:center">
            <div style="font-size:20px;font-weight:500;color:${colI}">${pctI}%</div>
            <div style="${lbl}">Izin</div>
        </div>
        <div style="background:var(--color-bg);border:0.5px solid var(--color-border);border-radius:var(--radius);padding:10px;text-align:center">
            <div style="font-size:20px;font-weight:500;color:${colS}">${pctS}%</div>
            <div style="${lbl}">Sakit</div>
        </div>
        <div style="background:var(--color-bg);border:0.5px solid var(--color-border);border-radius:var(--radius);padding:10px;text-align:center">
            <div style="font-size:20px;font-weight:500;color:${colA}">${pctA}%</div>
            <div style="${lbl}">Alpa</div>
        </div>
    </div>`;
}

async function loadWkAttendanceRecap() {
    const dateStart = document.getElementById('wk-att-start').value || null;
    const dateEnd   = document.getElementById('wk-att-end').value   || null;
    const container = document.getElementById('wk-att-recap');
    container.innerHTML = '<p class="hint">Memuat…</p>';
    try {
        const [programs, rows] = await Promise.all([
            getPrograms(),
            getAttendanceRecapPerClass(dateStart, dateEnd),
        ]);

        if (!rows.length) {
            container.innerHTML = '<p class="hint">Belum ada data kehadiran.</p>';
            return;
        }

        // Kelompokkan kelas per program
        const classMap = new Map(rows.map(r => [r.class_id, r]));
        const progMap  = new Map();
        for (const prog of programs) {
            progMap.set(prog.program_id, { ...prog, classes: [] });
        }

        // Ambil class → program mapping
        const { data: classProgData, error: cpErr } = await supabase
            .from('classes')
            .select('class_id, program_id')
            .in('class_id', rows.map(r => r.class_id));
        if (cpErr) throw cpErr;

        for (const cp of classProgData ?? []) {
            const prog = progMap.get(cp.program_id);
            const cls  = classMap.get(cp.class_id);
            if (prog && cls) prog.classes.push(cls);
        }

        // Filter program yang punya kelas
        const activeProgs = [...progMap.values()].filter(p => p.classes.length > 0);

        // Render accordion per program
        const html = activeProgs.map(prog => {
            const classAccordions = prog.classes
                .sort((a, b) => a.name.localeCompare(b.name, 'id'))
                .map(r => {
                    const tot  = r.HADIR + r.IZIN + r.SAKIT + r.ALPA;
                    const pctH = tot > 0 ? Math.round(r.HADIR       / tot * 100) : 0;
                    const pctI = tot > 0 ? Math.round(r.IZIN        / tot * 100) : 0;
                    const pctS = tot > 0 ? Math.round(r.SAKIT       / tot * 100) : 0;
                    const pctA = tot > 0 ? Math.round(r.ALPA / tot * 100) : 0;
                    const colH = pctH >= 80 ? 'var(--color-success)' : pctH >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
                    const safeId = r.class_id.replace(/[^a-z0-9]/gi, '_');
                    return `
                    <details class="att-accordion wz-accordion-inner" style="margin:4px 0 4px 16px">
                        <summary class="att-accordion-summary">
                            <span>${esc(r.name)}</span>
                            <span class="att-acc-names" style="display:flex;gap:10px;font-size:11px;font-weight:500">
                                <span style="color:${colH}">${pctH}%H</span>
                                <span style="color:var(--color-warning,#f59e0b)">${pctI}%I</span>
                                <span style="color:var(--color-primary)">${pctS}%S</span>
                                <span style="color:var(--color-danger)">${pctA}%A</span>
                            </span>
                        </summary>
                        <div id="wkdet-body-${safeId}"
                             data-class-id="${esc(r.class_id)}"
                             data-date-start="${esc(dateStart ?? '')}"
                             data-date-end="${esc(dateEnd ?? '')}"
                             style="padding:4px 0">
                            <p class="hint" style="padding:8px 16px">Memuat siswa…</p>
                        </div>
                    </details>`;
                }).join('');

            return `
            <details class="att-accordion" style="margin-bottom:8px">
                <summary class="att-accordion-summary">
                    <span>${esc(prog.name)}</span>
                    <span class="att-acc-names">${prog.classes.length} kelas</span>
                </summary>
                <div style="padding:4px 0">${classAccordions}</div>
            </details>`;
        }).join('');

        container.innerHTML = buildAttStatCards(rows) + html;

        // Lazy load siswa saat accordion kelas dibuka
        container.querySelectorAll('details.wz-accordion-inner').forEach(det => {
            det.addEventListener('toggle', async () => {
                if (!det.open) return;
                const body = det.querySelector('[data-class-id]');
                if (!body || body.dataset.loaded) return;
                body.dataset.loaded = '1';

                const classId  = body.dataset.classId;
                const dStart   = body.dataset.dateStart || null;
                const dEnd     = body.dataset.dateEnd   || null;

                try {
                    const students = await getWaliAttendanceSummary(
                        classId, config.current_academic_year, dStart, dEnd
                    );
                    if (!students.length) {
                        body.innerHTML = '<p class="hint" style="padding:8px 16px">Belum ada data kehadiran siswa.</p>';
                        return;
                    }
                    body.innerHTML = students
                        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'))
                        .map(s => {
                            const pct = s.total > 0 ? Math.round(s.HADIR / s.total * 100) : null;
                            const color = pct === null ? 'var(--color-text-muted)' : pct >= 80 ? 'var(--color-success)' : pct >= 60 ? 'var(--color-warning,#f59e0b)' : 'var(--color-danger)';
                            const safeId = s.student_id.replace(/[^a-z0-9]/gi, '_');
                            return `
                            <details class="att-accordion wz-accordion-inner"
                                     style="margin:4px 8px 4px 24px"
                                     data-student-id="${esc(s.student_id)}"
                                     data-date-start="${esc(dStart ?? '')}"
                                     data-date-end="${esc(dEnd ?? '')}">
                                <summary class="att-accordion-summary">
                                    <span class="att-acc-name">
                                        ${esc(s.full_name)}
                                        <span class="sub-label" style="margin-left:4px">${esc(s.nis)}</span>
                                    </span>
                                    <span style="color:${color};font-weight:600">
                                        ${pct !== null ? pct + '%' : '—'}
                                    </span>
                                </summary>
                                <div id="wkstu-body-${safeId}" style="padding:4px 0">
                                    <p class="hint" style="padding:8px 24px">Memuat sesi…</p>
                                </div>
                            </details>`;
                        }).join('');

                    // Lazy load sesi per siswa
                    body.querySelectorAll('details[data-student-id]').forEach(stuDet => {
                        stuDet.addEventListener('toggle', async () => {
                            if (!stuDet.open) return;
                            const sBody = stuDet.querySelector('[id^="wkstu-body-"]');
                            if (!sBody || sBody.dataset.loaded) return;
                            sBody.dataset.loaded = '1';
                            const sid    = stuDet.dataset.studentId;
                            const ds     = stuDet.dataset.dateStart || null;
                            const de     = stuDet.dataset.dateEnd   || null;
                            if (!ds || !de) {
                                sBody.innerHTML = '<p class="hint" style="padding:8px 24px">Pilih rentang tanggal untuk melihat detail sesi. Untuk data lengkap, gunakan fitur Unduh Excel.</p>';
                                return;
                            }
                            try {
                                const sessions = await getStudentAttendanceSessions(sid, ds, de);
                                if (!sessions.length) {
                                    sBody.innerHTML = '<p class="hint" style="padding:8px 24px">Belum ada sesi tercatat.</p>';
                                    return;
                                }
                                const STATUS_COLOR = {
                                    HADIR: 'var(--color-success)',
                                    IZIN:  'var(--color-warning,#f59e0b)',
                                    SAKIT: 'var(--color-primary)',
                                    ALPA: 'var(--color-danger)',
                                };
                                const STATUS_LABEL = { HADIR: 'Hadir', IZIN: 'Izin', SAKIT: 'Sakit', ALPA: 'Alpa' };
                                sBody.innerHTML = sessions.map(s => `
                                    <div style="display:flex;align-items:center;gap:8px;
                                        padding:7px 24px;border-top:0.5px solid var(--color-border)">
                                        <span style="font-size:12px;color:var(--color-text-muted);min-width:90px">
                                            ${esc(s.schedule.session_date)} ${fmtTime(s.schedule.session_start)}
                                        </span>
                                        <span style="flex:1;font-size:12px;color:var(--color-text-muted)">
                                            ${esc(s.schedule.subject?.name ?? '—')} · ${esc(s.schedule.teacher?.full_name ?? '—')}
                                        </span>
                                        <span style="font-size:11px;font-weight:600;
                                            color:${STATUS_COLOR[s.status] ?? 'var(--color-text-muted)'}">
                                            ${STATUS_LABEL[s.status] ?? esc(s.status)}
                                        </span>
                                    </div>`).join('');
                            } catch(err) {
                                sBody.innerHTML = `<div class="alert alert-danger" style="margin:8px 24px">${esc(fe(err))}</div>`;
                            }
                        });
                    });

                } catch (err) {
                    body.innerHTML = `<div class="alert alert-danger" style="margin:8px 16px">${esc(fe(err))}</div>`;
                }
            });
        });

    } catch (err) {
        container.innerHTML = `<div class="alert alert-danger">${esc(fe(err))}</div>`;
    }
}


const HANDLER_ROLE_LABELS = {
    GURU: 'Guru', WALI_KELAS: 'Wali Kelas', BK: 'BK',
    KEPSEK: 'Kepala Sekolah', WAKA_KESISWAAN: 'Waka Kesiswaan',
    WAKA_KURIKULUM: 'Waka Kurikulum',
};


// ─── TAB WAKA KURIKULUM ───────────────────────────────────────

let _wkKur1Visible = false;
let _wkKur2Visible = false;
let _wkKurTabInit  = false;

async function initWakaKurTab() {
    if (!_wkKurTabInit) {
        _wkKurTabInit = true;
        // Default Panel 2: 7 hari terakhir — selaras dengan scope Panel 1 (hari ini)
        const weekAgo = localDateStr(new Date(Date.now() - 6 * 86400000));
        document.getElementById('wk-kur-start').value = weekAgo;
        document.getElementById('wk-kur-end').value   = localDateStr();
        document.getElementById('wk-kur1-refresh').onclick = () => { loadWkKurStats(localDateStr(), localDateStr()); loadWkKur1(localDateStr()); };
        document.getElementById('wk-kur1-btn').onclick = handleWkKur1Btn;
        document.getElementById('wk-kur2-btn').onclick = handleWkKur2Btn;
    }
    // Selalu reload Panel 1 + stats saat tab dibuka agar data terbaru tampil
    await Promise.all([loadWkKurStats(localDateStr(), localDateStr()), loadWkKur1(localDateStr())]);
    await loadWakaDocApprovals();
}

async function loadWkKurStats(dateStart, dateEnd, prefix = 'wk-kur', emptyMsg = 'Tidak ada sesi hari ini') {
    const elHadir       = document.getElementById(`${prefix}-val-hadir`);
    const elPending     = document.getElementById(`${prefix}-val-pending`);
    const elTidak       = document.getElementById(`${prefix}-val-tidak`);
    const elDetailSudah = document.getElementById(`${prefix}-detail-sudah`);
    const elDetailBelum = document.getElementById(`${prefix}-detail-belum`);
    const elDetailTidak = document.getElementById(`${prefix}-detail-tidak`);

    if (!elHadir) return;

    elHadir.textContent = '…'; elPending.textContent = '…'; elTidak.textContent = '…';

    try {
        const today = localDateStr();
        const isHariIniPanel = (dateStart === today && dateEnd === today)
            || (!dateStart && !dateEnd);

        let hariIniData, tidakData;

        if (isHariIniPanel) {
            // Panel 1: card 1+2 = hari ini, card 3 = 7 hari terakhir
            const sevenDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().split('T')[0];
            [hariIniData, tidakData] = await Promise.all([
                getAttendanceFillRate(today, today),
                getAttendanceFillRate(sevenDaysAgo, today),
            ]);
        } else {
            // Panel 2: semua card pakai rentang yang dipilih user
            hariIniData = await getAttendanceFillRate(dateStart, dateEnd);
            tidakData = hariIniData;
        }

        // Card 1 — Sudah isi
        elHadir.textContent = hariIniData.hadir;
        if (elDetailSudah) {
            elDetailSudah.textContent = hariIniData.total > 0
                ? `${hariIniData.hadir} dari ${hariIniData.total} sesi`
                : emptyMsg;
        }

        // Card 2 — Belum diisi
        elPending.textContent = hariIniData.pending;
        if (elDetailBelum) {
            elDetailBelum.textContent = hariIniData.pending > 0
                ? `${hariIniData.pending} sesi belum diisi`
                : 'semua sesi sudah diproses';
        }

        // Card 3 — Tidak hadir
        elTidak.textContent = tidakData.tidak;
        if (elDetailTidak) {
            elDetailTidak.textContent = isHariIniPanel
                ? `${tidakData.tidak} sesi, 7 hari terakhir`
                : `${tidakData.tidak} sesi dalam rentang ini`;
        }

    } catch (e) {
        elHadir.textContent = '!'; elPending.textContent = '!'; elTidak.textContent = '!';
        console.error('[loadWkKurStats]', e);
    }
}

async function loadWkKur1(date) {
    const hintEl = document.getElementById('wk-kur1-hint');
    const wrapEl = document.getElementById('wk-kur1-wrap');
    const tbody  = document.getElementById('wk-kur1-body');
    const btn    = document.getElementById('wk-kur1-btn');

    hintEl.style.display = 'none';
    wrapEl.style.display = 'none';
    btn.style.display    = 'none';

    try {
        const rows = await getPendingAttendanceSessions(date);
        tbody.innerHTML = rows.length === 0
            ? `<tr><td colspan="5" class="hint" style="text-align:center;padding:12px">✓ Tidak ada sesi yang menunggu pengisian absensi hari ini.</td></tr>`
            : rows.map((r, i) => `<tr>
            <td style="text-align:center">${i + 1}</td>
            <td>${esc(r.teacher?.full_name ?? '—')}</td>
            <td>${esc(r.subject?.name ?? '—')}</td>
            <td>${esc(r.class?.name ?? '—')}</td>
            <td>${fmtTime(r.session_start)} – ${fmtTime(r.session_end)}</td>
        </tr>`).join('');
        wrapEl.style.display = '';
        btn.style.display    = '';
        btn.textContent      = 'Sembunyikan';
        _wkKur1Visible = true;
    } catch (err) {
        hintEl.textContent   = `Gagal memuat data. ${fe(err)}`;
        hintEl.style.display = 'block';
    }
}

function handleWkKur1Btn() {
    const wrapEl = document.getElementById('wk-kur1-wrap');
    const btn    = document.getElementById('wk-kur1-btn');
    _wkKur1Visible = !_wkKur1Visible;
    wrapEl.style.display = _wkKur1Visible ? '' : 'none';
    btn.textContent      = _wkKur1Visible ? 'Sembunyikan' : 'Tampilkan';
}

async function loadWkKur2() {
    const hintEl    = document.getElementById('wk-kur2-hint');
    const wrapEl    = document.getElementById('wk-kur2-wrap');
    const tbody     = document.getElementById('wk-kur2-body');
    const btn       = document.getElementById('wk-kur2-btn');
    const dateStart = document.getElementById('wk-kur-start').value;
    const dateEnd   = document.getElementById('wk-kur-end').value;

    const statsRow = document.getElementById('wk-kur2-stats-row');
    hintEl.style.display    = 'none';
    wrapEl.style.display    = 'none';
    statsRow.style.display  = 'none';
    btn.disabled            = true;
    btn.textContent         = 'Memuat…';

    try {
        const [groups] = await Promise.all([
            getPendingSessionsByTeacher(dateStart || null, dateEnd || null),
            loadWkKurStats(dateStart || null, dateEnd || null, 'wk-kur2', 'Tidak ada sesi pada rentang ini'),
        ]);
        statsRow.style.display = 'grid';
        btn.disabled = false;
        if (groups.length === 0) {
            hintEl.textContent   = '✓ Tidak ada sesi yang menunggu pengisian absensi pada rentang ini.';
            hintEl.style.display = 'block';
            btn.textContent      = 'Sembunyikan';
            _wkKur2Visible = true;
            return;
        }

        const THRESHOLD = 10;
        let html = '';
        groups.forEach((row, idx) => {
            const count    = Number(row.jumlah);
            const alert    = count >= THRESHOLD;
            const detailId = `wk-kur2-detail-${idx}`;
            const color    = alert ? 'var(--color-danger,#ef4444)' : '';
            const badge    = alert
                ? `<span style="font-size:11px;background:var(--color-danger,#ef4444);color:#fff;border-radius:4px;padding:1px 6px;margin-left:6px">≥${THRESHOLD}×</span>`
                : '';
            html += `<tr style="cursor:pointer" onclick="_wkKur2ToggleDetail('${detailId}','${row.teacher_id}','${esc(dateStart||'')}','${esc(dateEnd||'')}')">
                <td style="text-align:center">${idx + 1}</td>
                <td style="color:${color};font-weight:${alert?'600':'400'}">${esc(row.teacher_name)}${badge}</td>
                <td style="text-align:center;color:${color};font-weight:${alert?'600':'400'}">${count} sesi</td>
                <td style="text-align:center;font-size:18px;color:var(--color-text-muted)">&#8250;</td>
            </tr>
            <tr id="${detailId}" style="display:none" data-loaded="0">
                <td colspan="4" style="padding:0">
                    <table style="width:100%;border-collapse:collapse;background:var(--color-surface-raised,rgba(0,0,0,.15))">
                        <thead><tr style="font-size:11px;color:var(--color-text-muted)">
                            <th style="padding:6px 12px;text-align:left">Tanggal</th>
                            <th style="padding:6px 12px;text-align:left">Sesi</th>
                            <th style="padding:6px 12px;text-align:left">Mata Pelajaran</th>
                            <th style="padding:6px 12px;text-align:left">Kelas</th>
                        </tr></thead>
                        <tbody id="${detailId}-body"><tr><td colspan="4" style="padding:8px 12px;color:var(--color-text-muted)">Memuat…</td></tr></tbody>
                    </table>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
        wrapEl.style.display = '';
        btn.textContent      = 'Sembunyikan';
        _wkKur2Visible = true;
    } catch (err) {
        btn.disabled         = false;
        btn.textContent      = 'Tampilkan';
        hintEl.textContent   = `Gagal memuat data. ${fe(err)}`;
        hintEl.style.display = 'block';
    }
}

async function _wkKur2ToggleDetail(detailId, teacherId, dateStart, dateEnd) {
    const row = document.getElementById(detailId);
    if (!row) return;
    const visible = row.style.display !== 'none';
    row.style.display = visible ? 'none' : '';
    if (!visible && row.dataset.loaded === '0') {
        row.dataset.loaded = '1';
        const bodyEl = document.getElementById(detailId + '-body');
        try {
            const sesi = await getPendingSessionsDetail(teacherId, dateStart || null, dateEnd || null);
            bodyEl.innerHTML = sesi.length === 0
                ? `<tr><td colspan="4" style="padding:8px 12px;color:var(--color-text-muted)">Tidak ada data.</td></tr>`
                : sesi.map(s => `<tr style="font-size:13px">
                    <td style="padding:5px 12px">${esc(s.session_date ?? '—')}</td>
                    <td style="padding:5px 12px">${fmtTime(s.session_start)} – ${fmtTime(s.session_end)}</td>
                    <td style="padding:5px 12px">${esc(s.subject_name ?? '—')}</td>
                    <td style="padding:5px 12px">${esc(s.class_name ?? '—')}</td>
                </tr>`).join('');
        } catch (err) {
            bodyEl.innerHTML = `<tr><td colspan="4" style="padding:8px 12px;color:var(--color-danger,#ef4444)">Gagal memuat. ${fe(err)}</td></tr>`;
        }
    }
}

function handleWkKur2Btn() {
    if (_wkKur2Visible) {
        document.getElementById('wk-kur2-wrap').style.display = 'none';
        document.getElementById('wk-kur2-stats-row').style.display = 'none';
        document.getElementById('wk-kur2-hint').style.display = 'none';
        _wkKur2Visible = false;
        document.getElementById('wk-kur2-btn').textContent = 'Tampilkan';
    } else {
        loadWkKur2();
    }
}

// ─── TAB KEPSEK (Monitoring) ─────────────────────────────────

const BULAN_ID = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

function _prevAcademicYear() {
    const y = parseInt(config?.current_academic_year?.split('/')[0] ?? new Date().getFullYear());
    return `${y - 1}/${y}`;
}

function fmtChartLabel(dateStr, byMonth) {
    const d = new Date(dateStr + 'T00:00:00');
    return byMonth
        ? BULAN_ID[d.getMonth()] + ' ' + d.getFullYear()
        : d.getDate() + ' ' + BULAN_ID[d.getMonth()];
}

// ─── Tab Waka Humas ──────────────────────────────────────────
let _humasTabInit = false;

async function initWakaHumasTab() {
    const body = document.querySelector('#tab-waka_humas .page-body');
    if (!body) return;

    if (!_humasTabInit) {
        _humasTabInit = true;
        body.innerHTML = '<p class="hint">Memuat…</p>';

        const slug = localStorage.getItem('school_slug') || new URLSearchParams(window.location.search).get('school') || '';
        const base = window.location.origin + window.location.pathname.replace(/\/guru\/[^/]*$/, '');
        const portalUrl = (path) => slug ? `${base}/${path}?school=${encodeURIComponent(slug)}` : null;

        const siswaUrl       = portalUrl('student/index.html');
        const ortuUrl        = portalUrl('parent/index.html');
        const stakeholderUrl = portalUrl('stakeholder/index.html');

        const [siswaRes, alumniRes, ortuRes, stakeRes, monData] = await Promise.allSettled([
            supabase.from('students').select('student_id', { count: 'exact', head: true }).eq('student_status', 'AKTIF'),
            supabase.from('students').select('student_id', { count: 'exact', head: true }).eq('student_status', 'ALUMNI'),
            supabase.from('users').select('user_id', { count: 'exact', head: true }).eq('role_type', 'ORTU').eq('is_active', true),
            supabase.from('users').select('user_id', { count: 'exact', head: true }).eq('role_type', 'STAKEHOLDER').eq('is_active', true),
            getKepsekMonitoring('7_hari'),
        ]);

        const siswaCount = siswaRes.status  === 'fulfilled' ? (siswaRes.value.count  ?? 0) : '—';
        const alumniCount= alumniRes.status === 'fulfilled' ? (alumniRes.value.count ?? 0) : '—';
        const ortuCount  = ortuRes.status   === 'fulfilled' ? (ortuRes.value.count   ?? 0) : '—';
        const stakeCount = stakeRes.status  === 'fulfilled' ? (stakeRes.value.count  ?? 0) : '—';

        const s        = monData.status === 'fulfilled' ? (monData.value?.summary ?? {}) : {};
        const pctSiswa = s.pct_siswa != null ? s.pct_siswa + '%' : '—';
        const pctGuru  = s.pct_guru  != null ? s.pct_guru  + '%' : '—';

        const cardStyle = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;padding:16px;text-align:center';
        const lbl = 'font-size:12px;color:var(--color-text-muted);margin-top:4px';
        const copyBtn = (url, label) => url
            ? `<button class="btn btn-secondary btn-sm humas-copy-btn" data-url="${esc(url)}">${label}</button>`
            : `<button class="btn btn-secondary btn-sm" disabled>${label}</button>`;

        body.innerHTML = `
            <div class="section-card">
                <h3 style="margin:0 0 12px">Ringkasan Data Sekolah</h3>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-primary)">${esc(String(siswaCount))}</div>
                        <div style="${lbl}">Siswa Aktif</div>
                    </div>
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-text)">${esc(String(alumniCount))}</div>
                        <div style="${lbl}">Alumni</div>
                    </div>
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-text)">${esc(String(ortuCount))}</div>
                        <div style="${lbl}">Orang Tua Terdaftar</div>
                    </div>
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-text)">${esc(String(stakeCount))}</div>
                        <div style="${lbl}">Stakeholder</div>
                    </div>
                </div>
            </div>

            <div class="section-card">
                <h3 style="margin:0 0 12px">Kehadiran 7 Hari Terakhir</h3>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-success,#22c55e)">${esc(pctSiswa)}</div>
                        <div style="${lbl}">Kehadiran Siswa</div>
                    </div>
                    <div style="${cardStyle}">
                        <div style="font-size:24px;font-weight:600;color:var(--color-primary)">${esc(pctGuru)}</div>
                        <div style="${lbl}">Kehadiran Guru di Kelas</div>
                    </div>
                </div>
            </div>

            <div class="section-card">
                <h3 style="margin:0 0 12px">Link Portal</h3>
                <p style="font-size:13px;color:var(--color-text-muted);margin:0 0 12px">Salin dan bagikan link berikut kepada pihak terkait.</p>
                <div style="display:flex;flex-direction:column;gap:8px">
                    ${copyBtn(siswaUrl,       'Salin Link Siswa')}
                    ${copyBtn(ortuUrl,        'Salin Link Orang Tua')}
                    ${copyBtn(stakeholderUrl, 'Salin Link Stakeholder')}
                </div>
                <p id="humas-copy-feedback" style="display:none;margin-top:8px;font-size:13px;color:var(--color-success,#22c55e)">✓ Tersalin ke clipboard!</p>
            </div>
        `;

        body.querySelectorAll('.humas-copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(btn.dataset.url);
                    const fb = document.getElementById('humas-copy-feedback');
                    fb.style.display = 'block';
                    setTimeout(() => { fb.style.display = 'none'; }, 2000);
                } catch {
                    prompt('Salin URL ini:', btn.dataset.url);
                }
            });
        });
    }
}

let _ksTabInit = false;
let _ksChart   = null;

async function initKepsekTab() {
    if (!_ksTabInit) {
        _ksTabInit = true;

        // Wire period preset buttons
        document.getElementById('ks-period-toggle').addEventListener('click', e => {
            const btn = e.target.closest('.ks-period-btn');
            if (!btn) return;
            document.querySelectorAll('.ks-period-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const period = btn.dataset.period;
            const ayLalu = period === 'tahun_ajaran_lalu' ? _prevAcademicYear() : null;
            loadKepsekMonitoring(period, ayLalu);
        });

        // Wire date range button
        document.getElementById('ks-range-btn').addEventListener('click', () => {
            const start = document.getElementById('ks-range-start').value;
            const end   = document.getElementById('ks-range-end').value;
            if (!start || !end) return;
            document.querySelectorAll('.ks-period-btn').forEach(b => b.classList.remove('active'));
            loadKepsekMonitoring('rentang', null, start, end);
        });

        // Default date range: 7 hari terakhir
        document.getElementById('ks-range-start').value = localDateStr(new Date(Date.now() - 6 * 86400000));
        document.getElementById('ks-range-end').value   = localDateStr();
    }
    await loadKepsekMonitoring('7_hari');
    await loadKepsekDisahkanDocs();
}

let _ksAdminTabInit = false;

async function initKsAdminTab() {
    if (!_ksAdminTabInit) {
        _ksAdminTabInit = true;
        document.getElementById('ks-add-admin-form').addEventListener('submit', handleAddAdmin);
    }
    await loadAdminList();
}

async function loadKepsekMonitoring(period, academicYear = null, dateStart = null, dateEnd = null) {
    const errEl    = document.getElementById('ks-monitoring-error');
    const pctSiswa = document.getElementById('ks-pct-siswa');
    const pctGuru  = document.getElementById('ks-pct-guru');
    const detSiswa = document.getElementById('ks-detail-siswa');
    const detGuru  = document.getElementById('ks-detail-guru');
    const hintEl   = document.getElementById('ks-chart-hint');

    pctSiswa.textContent = '…';
    pctGuru.textContent  = '…';
    detSiswa.textContent = '';
    detGuru.textContent  = '';
    errEl.style.display  = 'none';

    try {
        const d = await getKepsekMonitoring(period, academicYear, dateStart, dateEnd);
        const s = d.summary ?? {};

        pctSiswa.textContent = s.pct_siswa != null ? s.pct_siswa + '%' : '—';
        pctGuru.textContent  = s.pct_guru  != null ? s.pct_guru  + '%' : '—';
        detSiswa.textContent = (s.siswa_total > 0)
            ? `${s.siswa_hadir} dari ${s.siswa_total} sesi tercatat`
            : 'Belum ada data';
        detGuru.textContent = (s.guru_total > 0)
            ? `${s.guru_hadir} dari ${s.guru_total} sesi terjadwal`
            : 'Belum ada data';

        const chartData = d.chart ?? [];
        hintEl.textContent = chartData.length === 0
            ? 'Belum ada data pada periode ini'
            : d.by_month ? 'Persentase kehadiran per bulan' : 'Persentase kehadiran per hari';

        renderKepsekChart(chartData, d.by_month);
    } catch (err) {
        errEl.textContent   = `Gagal memuat data: ${fe(err)}`;
        errEl.style.display = 'block';
        pctSiswa.textContent = '—';
        pctGuru.textContent  = '—';
        console.error('[kepsek monitoring]', err);
    }
}

function renderKepsekChart(chartData, byMonth) {
    const canvas = document.getElementById('ks-chart');
    const labels     = chartData.map(p => fmtChartLabel(p.date, byMonth));
    const dataSiswa  = chartData.map(p => p.pct_siswa);
    const dataGuru   = chartData.map(p => p.pct_guru);

    if (_ksChart) { _ksChart.destroy(); _ksChart = null; }

    _ksChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Kehadiran Siswa (%)',
                    data: dataSiswa,
                    borderColor: '#1D9E75',
                    backgroundColor: '#1D9E7518',
                    tension: 0.3,
                    fill: true,
                    pointRadius: chartData.length <= 14 ? 4 : 2,
                    spanGaps: true,
                },
                {
                    label: 'Kehadiran Guru (%)',
                    data: dataGuru,
                    borderColor: '#185FA5',
                    backgroundColor: '#185FA518',
                    tension: 0.3,
                    fill: true,
                    pointRadius: chartData.length <= 14 ? 4 : 2,
                    spanGaps: true,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y + '%' : '—'}`,
                    },
                },
            },
            scales: {
                y: {
                    min: 0, max: 100,
                    ticks: { callback: v => v + '%', font: { size: 11 } },
                    grid: { color: '#0001' },
                },
                x: { ticks: { font: { size: 11 }, maxRotation: 45 } },
            },
        },
    });
}

async function loadAdminList() {
    const el = document.getElementById('ks-admin-list');
    try {
        const admins = await listSchoolAdmins();
        if (!admins.length) {
            el.innerHTML = '<p class="hint">Belum ada data admin.</p>';
            return;
        }
        el.innerHTML = `
            <table class="data-table" style="width:100%">
                <thead><tr><th>Nama</th><th></th></tr></thead>
                <tbody>
                    ${admins.map(a => `
                        <tr>
                            <td>${esc(a.full_name)}</td>
                            <td style="text-align:right">
                                ${a.user_id === currentUser.user_id
                                    ? '<span class="hint">(Anda)</span>'
                                    : `<button class="btn btn-sm btn-danger" data-uid="${esc(a.user_id)}" data-name="${esc(a.full_name)}" onclick="confirmRemoveAdmin(this)">Hapus</button>`
                                }
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>`;
    } catch (err) {
        el.innerHTML = `<p class="hint">Gagal memuat daftar admin: ${fe(err)}</p>`;
    }
}

async function handleAddAdmin(e) {
    e.preventDefault();
    const btn     = document.getElementById('ks-add-admin-btn');
    const msgEl   = document.getElementById('ks-add-admin-msg');
    const resultEl = document.getElementById('ks-new-admin-result');
    const name    = document.getElementById('ks-admin-name').value.trim();
    const loginId = document.getElementById('ks-admin-loginid').value.trim();
    const idType  = document.getElementById('ks-admin-idtype').value;

    if (loginId.length < 9) {
        msgEl.textContent   = 'NIP/NIK minimal 9 karakter.';
        msgEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    msgEl.style.display = 'none';
    resultEl.style.display = 'none';

    try {
        const result = await addSchoolAdmin({ full_name: name, login_identifier: loginId, identifier_type: idType });

        document.getElementById('ks-result-loginid').textContent   = result.login_identifier;
        document.getElementById('ks-result-password').textContent  = result.temp_password;
        resultEl.style.display = 'block';

        e.target.reset();
        e.target.closest('details').open = false;

        await loadAdminList();
    } catch (err) {
        msgEl.textContent    = fe(err);
        msgEl.style.display  = 'block';
    } finally {
        btn.disabled = false;
    }
}

window.confirmRemoveAdmin = async function(btn) {
    const uid  = btn.dataset.uid;
    const name = btn.dataset.name;
    if (!confirm(`Hapus akun admin "${name}"?\n\nMereka tidak akan bisa login lagi.`)) return;

    btn.disabled = true;
    try {
        await removeSchoolAdmin(uid);
        await loadAdminList();
    } catch (err) {
        alert(`Gagal menghapus: ${fe(err)}`);
        btn.disabled = false;
    }
};

// ─── TAB KASUS ───────────────────────────────────────────────

const CASE_STATUS_LABEL = {
    OPEN:         'Buka',
    UNDER_REVIEW: 'Ditinjau',
    INTERVENTION: 'Intervensi',
    MONITORING:   'Monitoring',
    CLOSED:       'Tutup',
};
const CASE_STATUS_BADGE = {
    OPEN:         'badge-open',
    UNDER_REVIEW: 'badge-review',
    INTERVENTION: 'badge-intervention',
    MONITORING:   'badge-monitoring',
    CLOSED:       'badge-closed',
};
const CASE_TRACK_LABEL = { SEKOLAH: 'Sekolah' };
const ROLE_LABEL = {
    GURU: 'Guru', BK: 'BK', WALI_KELAS: 'Wali Kelas',
    KEPSEK: 'Kepala Sekolah',
    WAKA_KESISWAAN: 'Waka Kesiswaan', WAKA_KURIKULUM: 'Waka Kurikulum',
};
// Rantai = PENUNTUN saja (referensi untuk peringatan), BUKAN batasan.
// Eskalasi antar-internal bebas; server hanya mengunci: target wajib peran internal kasus.
const ESCALATION_CHAIN = {
    SEKOLAH: ['GURU','BK','WALI_KELAS','WAKA_KESISWAAN','KEPSEK'],
};
const STATUS_AFTER_CURRENT = {
    OPEN:         ['UNDER_REVIEW','INTERVENTION','MONITORING'],
    UNDER_REVIEW: ['INTERVENTION','MONITORING'],
    INTERVENTION: ['MONITORING'],
    MONITORING:   [],
};
const EVENT_TYPE_LABEL = {
    COMMENT_ADDED:          'Komentar',
    STATUS_CHANGED:         'Status Berubah',
    DECISION_ESCALATE:      'Eskalasi',
    DECISION_CLOSE:         'Kasus Ditutup',
    FINAL_DECISION_MADE:    'Keputusan Final',
    STUDENT_UPDATE_ADDED:   'Update Siswa',
    PARENT_MESSAGE_RECEIVED:'Pesan Orang Tua',
    PARENT_MESSAGE_LINKED:  'Pesan Terhubung',
    PARENT_REPLY_SENT:      'Balasan Terkirim',
    CASE_LOCKED:            'Kasus Dikunci',
    CASE_UNLOCKED:          'Kasus Dibuka Kunci',
    AUDIENCE_CHANGED:       'Visibilitas Diubah',
};

const KASUS_PAGE    = 50;
let _kasusTabInit   = false;
let _kasusAllCases  = [];
let _kasusOffset    = 0;
let _kasusHasMore   = false;
let _kasusCurrentId = null;

async function initKasusTab() {
    markKasusAsSeen();
    if (_kasusTabInit) { renderKasusList(); return; }
    _kasusTabInit = true;

    await ensureStudentPool();

    // Filters
    document.getElementById('kasus-filter-status').addEventListener('change', () => loadKasusList());
    document.getElementById('kasus-filter-track').addEventListener('change',  () => loadKasusList());

    // Sembunyikan tombol buat kasus untuk role ADMINISTRATIVE (bukan penanganan siswa)
    if (currentUser.role_type === 'ADMINISTRATIVE') {
        document.getElementById('kasus-new-btn').style.display = 'none';
    }

    // Offline guard — disable tombol + banner saat tidak ada koneksi
    function syncKasusOnlineState() {
        const online = navigator.onLine;
        const btn    = document.getElementById('kasus-new-btn');
        const banner = document.getElementById('kasus-offline-banner');
        if (btn) btn.disabled         = !online;
        banner.style.display  = online ? 'none' : 'block';
    }
    syncKasusOnlineState();
    window.addEventListener('online',  syncKasusOnlineState);
    window.addEventListener('offline', syncKasusOnlineState);

    // New case button
    document.getElementById('kasus-new-btn').addEventListener('click', openKasusModal);
    document.getElementById('kasus-create-cancel-btn').addEventListener('click', closeKasusModal);
    document.getElementById('kasus-back-btn').addEventListener('click', showKasusList);

    // Create form
    const createForm  = document.getElementById('kasus-create-form');
    const searchEl    = document.getElementById('kasus-c-student-search');
    const studentIdEl = document.getElementById('kasus-c-student-id');
    const listEl      = document.getElementById('kasus-c-student-list');
    const trackField  = document.getElementById('kasus-c-track-field');
    const trackEl     = document.getElementById('kasus-c-track');

    // Semua pengguna selalu menggunakan jalur Sekolah
    trackField.style.display = 'none';
    trackEl.value = 'SEKOLAH';

    let kasusSearchSeq = 0;
    searchEl.addEventListener('input', async () => {
        const raw = searchEl.value.trim();
        const q   = raw.toLowerCase();
        if (q.length < 2) { listEl.style.display = 'none'; return; }

        const localPool = myStudents;
        const local = localPool.filter(s =>
            s.full_name.toLowerCase().includes(q) || s.nis?.includes(q)
        );

        let hits = local;
        if (isBroadObserver) {
            const seq = ++kasusSearchSeq;
            try {
                const remote = await searchStudents(raw, currentUser.school_id);
                if (seq !== kasusSearchSeq) return;
                const seen = new Set(local.map(s => s.student_id));
                hits = [...local, ...remote.filter(s => !seen.has(s.student_id))];
            } catch { /* fallback lokal */ }
        }

        hits = hits.slice(0, 12);
        if (!hits.length) { listEl.style.display = 'none'; return; }
        listEl.innerHTML = hits.map(r =>
            `<div style="padding:8px 12px; cursor:pointer; font-size:13px" data-id="${r.student_id}" data-name="${esc(r.full_name)}">${esc(r.full_name)} — ${esc(r.nis ?? '')}${r.class_name ? ' · ' + esc(r.class_name) : ''}</div>`
        ).join('');
        listEl.style.display = 'block';
        listEl.querySelectorAll('div').forEach(el => {
            el.addEventListener('click', () => {
                searchEl.value = el.dataset.name;
                studentIdEl.value = el.dataset.id;
                listEl.style.display = 'none';
            });
            el.addEventListener('mouseenter', () => { el.style.background = 'var(--color-bg)'; });
            el.addEventListener('mouseleave', () => { el.style.background = ''; });
        });
    });

    createForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msgEl  = document.getElementById('kasus-create-msg');
        const btnEl  = document.getElementById('kasus-create-submit-btn');
        const sId    = studentIdEl.value;
        const title  = document.getElementById('kasus-c-title').value.trim();
        const desc   = document.getElementById('kasus-c-desc').value.trim();
        const track  = document.getElementById('kasus-c-track').value;

        msgEl.style.display = 'none';
        if (!sId)             { showCreateMsg('Pilih siswa dari daftar.', true); return; }
        if (title.length < 5) { showCreateMsg('Judul minimal 5 karakter.', true); return; }
        if (desc.length < 20) { showCreateMsg('Deskripsi minimal 20 karakter.', true); return; }

        btnEl.disabled = true; btnEl.textContent = 'Menyimpan…';
        try {
            const r = await createCase({
                studentId:   sId,
                title,
                description: desc,
                track,
                audience: 'PRIVATE',
                authorUserId: currentUser.user_id,
                authorRole:   currentUser.role_type,
            });
            closeKasusModal();
            if (r._queued) {
                showCreateMsg('Kasus disimpan lokal. Akan dikirim saat koneksi kembali.', false);
            }
            await loadKasusList();
        } catch (err) {
            showCreateMsg(fe(err, 's'), true);
        } finally {
            btnEl.disabled = false; btnEl.textContent = 'Simpan';
        }
    });

    await loadKasusList();
}

function showCreateMsg(msg, isErr = false) {
    const el = document.getElementById('kasus-create-msg');
    el.style.display = 'block';
    el.style.color   = isErr ? 'var(--color-danger)' : 'var(--color-success)';
    el.textContent   = msg;
}

function openKasusModal() {
    if (!navigator.onLine) return;
    const modal = document.getElementById('kasus-create-modal');
    document.getElementById('kasus-create-form').reset();
    document.getElementById('kasus-c-student-id').value = '';
    document.getElementById('kasus-create-msg').style.display = 'none';
    document.getElementById('kasus-c-student-list').style.display = 'none';
    modal.style.display = 'flex';
}
function closeKasusModal() {
    document.getElementById('kasus-create-modal').style.display = 'none';
}

async function loadKasusList(append = false) {
    const contentEl = document.getElementById('kasus-list-content');
    if (!append) {
        _kasusAllCases = [];
        _kasusOffset   = 0;
        contentEl.innerHTML = '<p class="hint">Memuat kasus…</p>';
    }
    const status = document.getElementById('kasus-filter-status').value;
    const track  = document.getElementById('kasus-filter-track').value;
    try {
        const rows = await getCases({ status, track, offset: _kasusOffset, limit: KASUS_PAGE + 1 });
        _kasusHasMore  = rows.length > KASUS_PAGE;
        const page     = _kasusHasMore ? rows.slice(0, KASUS_PAGE) : rows;
        _kasusAllCases = append ? [..._kasusAllCases, ...page] : page;
        _kasusOffset   = _kasusAllCases.length;
        renderKasusList();
    } catch (err) {
        if (!append) contentEl.innerHTML = `<div class="status-err">${esc(fe(err))}</div>`;
    }
}

function renderKasusList() {
    const contentEl = document.getElementById('kasus-list-content');

    if (!_kasusAllCases.length) {
        contentEl.innerHTML = '<p class="hint">Tidak ada kasus yang sesuai filter.</p>';
        return;
    }

    contentEl.innerHTML = _kasusAllCases.map(r => `
        <div class="kasus-row" data-id="${r.case_id}">
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; flex-wrap:wrap">
                <strong style="font-size:14px; flex:1">${esc(r.title)}</strong>
                <span class="badge kasus-badge-${(r.status||'').toLowerCase()}">${esc(CASE_STATUS_LABEL[r.status] ?? r.status)}</span>
            </div>
            <div style="font-size:12px; color:var(--color-text-muted); margin-top:4px">
                ${esc(r.student?.full_name ?? 'Siswa tidak dapat ditampilkan')}${r.student?.nis ? ' (' + esc(r.student.nis) + ')' : ''}
                &middot; ${esc(CASE_TRACK_LABEL[r.track] ?? r.track)}
                &middot; Handler: ${esc(ROLE_LABEL[r.current_handler_role] ?? r.current_handler_role ?? '—')}
                &middot; ${fmt(r.created_at)}
            </div>
        </div>
    `).join('') + (_kasusHasMore
        ? `<div style="text-align:center;padding:12px">
               <button class="btn btn-secondary btn-sm" id="kasus-load-more-btn">Muat lebih…</button>
           </div>`
        : '');

    contentEl.querySelectorAll('.kasus-row').forEach(el => {
        el.addEventListener('click', () => openKasusDetail(el.dataset.id));
    });
    const moreBtn = document.getElementById('kasus-load-more-btn');
    if (moreBtn) moreBtn.addEventListener('click', async () => {
        moreBtn.disabled = true;
        moreBtn.textContent = 'Memuat…';
        await loadKasusList(true);
    });
}

function showKasusList() {
    document.getElementById('kasus-list-view').style.display = 'block';
    document.getElementById('kasus-detail-view').style.display = 'none';
    _kasusCurrentId = null;
}

async function openKasusDetail(caseId) {
    _kasusCurrentId = caseId;
    document.getElementById('kasus-list-view').style.display = 'none';
    document.getElementById('kasus-detail-view').style.display = 'block';
    document.getElementById('kasus-detail-header').innerHTML = '<p class="hint">Memuat…</p>';
    document.getElementById('kasus-events-list').innerHTML   = '<p class="hint">Memuat…</p>';
    document.getElementById('kasus-actions').style.display  = 'none';

    try {
        const [kasus, events] = await Promise.all([getCase(caseId), getCaseEvents(caseId)]);
        renderKasusDetail(kasus);
        renderKasusEvents(events);
        renderKasusActions(kasus);
    } catch (err) {
        document.getElementById('kasus-detail-header').innerHTML =
            `<div class="status-err">${esc(fe(err))}</div>`;
    }
}

function renderKasusDetail(k) {
    const el = document.getElementById('kasus-detail-header');
    el.innerHTML = `
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:12px">
            <h3 style="margin:0; flex:1">${esc(k.title)}</h3>
            <span class="badge kasus-badge-${(k.status||'').toLowerCase()}">${esc(CASE_STATUS_LABEL[k.status] ?? k.status)}</span>
        </div>
        <div style="font-size:13px; color:var(--color-text-muted); margin-bottom:12px">
            Siswa: <strong>${esc(k.student?.full_name ?? '—')}</strong> (${esc(k.student?.nis ?? '—')})
            &middot; Track: <strong>${esc(CASE_TRACK_LABEL[k.track] ?? k.track)}</strong>
            &middot; Dibuka oleh: ${esc(ROLE_LABEL[k.initiated_by_role] ?? k.initiated_by_role)}
            &middot; Handler saat ini: <strong>${esc(ROLE_LABEL[k.current_handler_role] ?? k.current_handler_role ?? '—')}</strong>
            ${k.is_locked ? '&middot; <span style="color:var(--color-warning)">🔒 Terkunci</span>' : ''}
        </div>
        <p style="font-size:14px; color:var(--color-text); margin:0">${esc(k.description)}</p>
    `;
}

function renderKasusEvents(events) {
    const el = document.getElementById('kasus-events-list');
    if (!events.length) {
        el.innerHTML = '<p class="hint">Belum ada event.</p>';
        return;
    }
    el.innerHTML = events.map(ev => {
        const label = EVENT_TYPE_LABEL[ev.event_type] ?? ev.event_type;
        const text  = ev.payload?.text ?? '';
        let detail  = '';
        if (ev.event_type === 'DECISION_ESCALATE')
            detail = `→ ${esc(ROLE_LABEL[ev.new_handler_role] ?? ev.new_handler_role)}`;
        if (ev.event_type === 'STATUS_CHANGED' || ev.event_type === 'DECISION_CLOSE' || ev.event_type === 'FINAL_DECISION_MADE')
            detail = `${esc(CASE_STATUS_LABEL[ev.previous_status] ?? ev.previous_status ?? '?')} → ${esc(CASE_STATUS_LABEL[ev.new_status] ?? ev.new_status ?? '?')}`;
        if (ev.event_type === 'AUDIENCE_CHANGED')
            detail = `${esc(AUDIENCE_LABEL[ev.payload?.previous] ?? ev.payload?.previous ?? '?')} → ${esc(AUDIENCE_LABEL[ev.payload?.next] ?? ev.payload?.next ?? '?')}`;
        return `
            <div class="case-event-item">
                <div style="font-size:12px; color:var(--color-text-muted); margin-bottom:4px">
                    <strong>${esc(label)}</strong>
                    ${detail ? `<span style="margin-left:6px">${detail}</span>` : ''}
                    &middot; ${esc(ev.author?.full_name ?? '—')} (${esc(ROLE_LABEL[ev.author_role_at_time] ?? ev.author_role_at_time)})
                    &middot; ${fmt(ev.created_at)}
                </div>
                ${text ? `<p style="font-size:13px; margin:0; color:var(--color-text)">${esc(text)}</p>` : ''}
            </div>`;
    }).join('');
}

// 6 peran yang boleh jadi handler/eskalasi tujuan kasus internal
const INTERNAL_CASE_ROLES = ['GURU','BK','WALI_KELAS','WAKA_KESISWAAN','KEPSEK'];
const AUDIENCE_LABEL = { PRIVATE: '🔒 Privat', RESTRICTED: '👥 Orang Tertentu', PUBLIC: '🌐 Semua Internal' };

function renderKasusActions(kasus) {
    const actionsEl     = document.getElementById('kasus-actions');
    const escalateBlock = document.getElementById('kasus-escalate-block');
    const statusBlock   = document.getElementById('kasus-status-block');
    const audienceBlock = document.getElementById('kasus-audience-block');
    const closeBtn      = document.getElementById('kasus-close-btn');
    const escalateTo    = document.getElementById('kasus-escalate-to');
    const statusSel     = document.getElementById('kasus-new-status');

    if (kasus.status === 'CLOSED') {
        actionsEl.style.display = 'none';
        return;
    }

    actionsEl.style.display = 'block';

    // ── Eskalasi BEBAS: semua internal boleh teruskan ke peran internal mana pun ──
    const isInternal = INTERNAL_CASE_ROLES.includes(currentUser.role_type);
    if (isInternal) {
        const chain = ESCALATION_CHAIN[kasus.track] ?? [];
        const handlerIdx = chain.indexOf(kasus.current_handler_role);
        const targets = INTERNAL_CASE_ROLES.filter(r => r !== kasus.current_handler_role);
        escalateTo.innerHTML = targets.map(r => {
            const isDownstream = handlerIdx >= 0 && chain.indexOf(r) < handlerIdx;
            return `<option value="${r}" data-downstream="${isDownstream}">${esc(ROLE_LABEL[r] ?? r)}${isDownstream ? ' ↩ lebih rendah' : ''}</option>`;
        }).join('');

        // Peringatan tak-memblokir saat pilih ke bawah
        const warnEl = document.getElementById('kasus-escalate-warn');
        function updateEscWarn() {
            const sel = escalateTo.options[escalateTo.selectedIndex];
            if (sel && sel.dataset.downstream === 'true') {
                warnEl.textContent = `Peran ${esc(ROLE_LABEL[sel.value] ?? sel.value)} ada di bawah handler saat ini dalam rantai referensi. Anda tetap bisa meneruskan — pastikan ini disengaja.`;
                warnEl.style.display = 'block';
            } else {
                warnEl.style.display = 'none';
            }
        }
        escalateTo.onchange = updateEscWarn;
        updateEscWarn();
        escalateBlock.style.display = 'block';
    } else {
        escalateBlock.style.display = 'none';
    }

    // ── Status change ──
    const nextStatuses = STATUS_AFTER_CURRENT[kasus.status] ?? [];
    const isHandler = kasus.current_handler_role === currentUser.role_type
        && (
            currentUser.role_type !== 'GURU'
            || kasus.created_by_user_id === currentUser.user_id
        );
    const canChangeStatus = isHandler || ['KEPSEK','BK','WAKA_KESISWAAN'].includes(currentUser.role_type);
    if (canChangeStatus && nextStatuses.length) {
        statusSel.innerHTML = nextStatuses.map(s =>
            `<option value="${s}">${esc(CASE_STATUS_LABEL[s])}</option>`
        ).join('');
        statusBlock.style.display = 'block';
    } else {
        statusBlock.style.display = 'none';
    }

    // Close: Kepsek/BK/handler
    const canClose = currentUser.role_type === 'KEPSEK' || isHandler;
    closeBtn.style.display = canClose ? 'inline-flex' : 'none';

    // ── Kelola Audiens (hanya internal) ──
    if (isInternal) {
        const badge = document.getElementById('kasus-audience-badge');
        const cur   = kasus.audience ?? 'PRIVATE';
        badge.textContent = AUDIENCE_LABEL[cur] ?? cur;
        badge.style.background = cur === 'PUBLIC' ? 'var(--color-success-bg, #d4edda)'
            : cur === 'RESTRICTED' ? 'var(--color-primary-bg)'
            : 'var(--color-bg)';
        audienceBlock.style.display = 'block';
        renderAudiencePanel(kasus, cur);
    } else {
        audienceBlock.style.display = 'none';
    }

    // ── Wire buttons (replace listeners by cloning) ──
    const newCommentBtn = replaceEl('kasus-comment-submit-btn');
    const newEscBtn     = replaceEl('kasus-escalate-btn');
    const newStatusBtn  = replaceEl('kasus-status-btn');
    const newCloseBtn   = replaceEl('kasus-close-btn');

    newCommentBtn.addEventListener('click', async () => {
        const text  = document.getElementById('kasus-comment-text').value.trim();
        const msgEl = document.getElementById('kasus-comment-msg');
        if (!text) { msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = 'Komentar tidak boleh kosong.'; return; }
        newCommentBtn.disabled = true; newCommentBtn.textContent = 'Mengirim…';
        try {
            await addCaseComment({ caseId: kasus.case_id, text, authorUserId: currentUser.user_id, authorRole: currentUser.role_type });
            document.getElementById('kasus-comment-text').value = '';
            msgEl.style.color = 'var(--color-success)'; msgEl.textContent = 'Komentar dikirim.';
            await refreshKasusDetail();
        } catch (err) {
            msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
        } finally {
            newCommentBtn.disabled = false; newCommentBtn.textContent = 'Kirim Komentar';
        }
    });

    newEscBtn.addEventListener('click', async () => {
        const to    = document.getElementById('kasus-escalate-to').value;
        const note  = document.getElementById('kasus-escalate-note').value.trim();
        const msgEl = document.getElementById('kasus-escalate-msg');
        newEscBtn.disabled = true; newEscBtn.textContent = 'Meneruskan…';
        try {
            await escalateCase({
                caseId: kasus.case_id,
                previousHandlerRole: kasus.current_handler_role,
                newHandlerRole: to,
                note,
                authorUserId:   currentUser.user_id,
                authorRole:     currentUser.role_type,
                previousStatus: kasus.status,
            });
            msgEl.style.color = 'var(--color-success)'; msgEl.textContent = `Diteruskan ke ${ROLE_LABEL[to] ?? to}.`;
            await refreshKasusDetail();
        } catch (err) {
            msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
        } finally {
            newEscBtn.disabled = false; newEscBtn.textContent = 'Teruskan';
        }
    });

    newStatusBtn.addEventListener('click', async () => {
        const newSt = document.getElementById('kasus-new-status').value;
        const note  = document.getElementById('kasus-status-note').value.trim();
        const msgEl = document.getElementById('kasus-status-msg');
        newStatusBtn.disabled = true; newStatusBtn.textContent = 'Menyimpan…';
        try {
            await changeCaseStatus({ caseId: kasus.case_id, previousStatus: kasus.status, newStatus: newSt, note, authorUserId: currentUser.user_id, authorRole: currentUser.role_type });
            msgEl.style.color = 'var(--color-success)'; msgEl.textContent = `Status diubah ke ${CASE_STATUS_LABEL[newSt]}.`;
            await refreshKasusDetail();
        } catch (err) {
            msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
        } finally {
            newStatusBtn.disabled = false; newStatusBtn.textContent = 'Ubah Status';
        }
    });

    newCloseBtn.addEventListener('click', async () => {
        const note  = document.getElementById('kasus-status-note').value.trim();
        const msgEl = document.getElementById('kasus-status-msg');
        if (newCloseBtn.dataset.confirming !== 'yes') {
            newCloseBtn.dataset.confirming = 'yes';
            msgEl.style.color   = 'var(--color-warning)';
            msgEl.textContent   = 'Kasus yang ditutup tidak bisa dibuka kembali. Klik "Tutup Kasus" sekali lagi untuk konfirmasi.';
            newCloseBtn.textContent = 'Konfirmasi Tutup';
            setTimeout(() => {
                if (newCloseBtn.dataset.confirming === 'yes') {
                    newCloseBtn.dataset.confirming = '';
                    newCloseBtn.textContent = 'Tutup Kasus';
                    msgEl.textContent = '';
                }
            }, 6000);
            return;
        }
        newCloseBtn.dataset.confirming = '';
        newCloseBtn.disabled = true; newCloseBtn.textContent = 'Menutup…';
        try {
            await closeCase({ caseId: kasus.case_id, note, authorUserId: currentUser.user_id, authorRole: currentUser.role_type, previousStatus: kasus.status });
            msgEl.style.color = 'var(--color-success)'; msgEl.textContent = 'Kasus berhasil ditutup.';
            await refreshKasusDetail();
        } catch (err) {
            msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
        } finally {
            newCloseBtn.disabled = false; newCloseBtn.textContent = 'Tutup Kasus';
        }
    });
}

function renderAudiencePanel(kasus, currentAudience) {
    const msgEl      = document.getElementById('kasus-audience-msg');
    const restricted = document.getElementById('kasus-aud-restricted-panel');

    // Highlight tombol aktif
    ['PRIVATE','RESTRICTED','PUBLIC'].forEach(a => {
        const btn = document.getElementById(`kasus-aud-${a.toLowerCase()}-btn`);
        if (!btn) return;
        btn.className = `btn btn-sm${a === currentAudience ? ' btn-primary' : ' btn-secondary'}`;
    });

    restricted.style.display = currentAudience === 'RESTRICTED' ? 'block' : 'none';
    if (currentAudience === 'RESTRICTED') loadAudienceMembers(kasus);

    ['PRIVATE','RESTRICTED','PUBLIC'].forEach(a => {
        const btn = replaceEl(`kasus-aud-${a.toLowerCase()}-btn`);
        btn.addEventListener('click', async () => {
            if (a === currentAudience) return;
            msgEl.style.color = ''; msgEl.textContent = 'Menyimpan…';
            try {
                await updateCaseAudience({ caseId: kasus.case_id, audience: a });
                await logCaseAudienceChange({
                    caseId: kasus.case_id,
                    previousAudience: currentAudience,
                    newAudience: a,
                    authorUserId: currentUser.user_id,
                    authorRole: currentUser.role_type,
                });
                msgEl.style.color = 'var(--color-success)';
                msgEl.textContent = `Audiens diubah ke: ${AUDIENCE_LABEL[a]}.`;
                await refreshKasusDetail();
            } catch (err) {
                msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
            }
        });
    });
}

async function fetchStudentSubject(studentId, knownUserId = null) {
    if (_studentSubjectCache.has(studentId)) return _studentSubjectCache.get(studentId);
    const [userId, parents] = await Promise.all([
        knownUserId != null ? Promise.resolve(knownUserId) : getStudentUserId(studentId),
        getStudentParents(studentId),
    ]);
    const result = { userId, parents };
    _studentSubjectCache.set(studentId, result);
    return result;
}

async function loadAudienceMembers(kasus) {
    const restrictedPanel = document.getElementById('kasus-aud-restricted-panel');
    const listEl  = document.getElementById('kasus-aud-members-list');
    const searchEl = document.getElementById('kasus-aud-member-search');
    const dropEl   = document.getElementById('kasus-aud-member-list');
    const msgEl    = document.getElementById('kasus-audience-msg');
    listEl.textContent = 'Memuat anggota…';

    // Pastikan container toggle subjek ada (inject sekali, innerHTML-nya ditimpa tiap panggil)
    let subjectPanel = document.getElementById('kasus-aud-subject-panel');
    if (!subjectPanel) {
        subjectPanel = document.createElement('div');
        subjectPanel.id = 'kasus-aud-subject-panel';
        restrictedPanel.insertBefore(subjectPanel, restrictedPanel.firstChild);
    }

    try {
        const studentId   = kasus.student?.student_id ?? null;
        const knownUserId = kasus.student?.user_id ?? null;

        const [members, subject] = await Promise.all([
            getCaseAudienceMembers(kasus.case_id),
            studentId ? fetchStudentSubject(studentId, knownUserId) : Promise.resolve(null),
        ]);
        const memberSet = new Set(members.map(m => m.user_id));
        const subjectUidSet = new Set();

        // ── Toggle siswa & ortu ──
        if (subject) {
            const rows = [];
            if (subject.userId) {
                rows.push({ uid: subject.userId, label: esc(kasus.student?.full_name ?? 'Siswa'), role: 'Siswa' });
            }
            subject.parents.forEach(p => {
                rows.push({ uid: p.parent_user_id, label: esc(p.users?.full_name ?? p.parent_user_id), role: 'Ortu' });
            });
            rows.forEach(r => subjectUidSet.add(r.uid));
            if (rows.length) {
                subjectPanel.innerHTML = `
                    <div style="font-size:12px;font-weight:600;color:var(--color-text-muted);margin-bottom:6px">Siswa &amp; Orang Tua Terkait</div>
                    ${rows.map(row => `
                        <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:4px;cursor:pointer">
                            <input type="checkbox" data-uid="${row.uid}" ${memberSet.has(row.uid) ? 'checked' : ''}
                                style="width:14px;height:14px;accent-color:var(--color-primary,#6366f1);cursor:pointer">
                            ${row.label} <span style="color:var(--color-text-muted)">(${row.role})</span>
                        </label>
                    `).join('')}
                    <div style="border-bottom:1px solid var(--color-border);margin:8px 0"></div>`;
                subjectPanel.querySelectorAll('input[type=checkbox][data-uid]').forEach(cb => {
                    cb.addEventListener('change', async () => {
                        const uid = cb.dataset.uid;
                        const nowChecked = cb.checked;
                        cb.disabled = true;
                        try {
                            if (nowChecked) {
                                await addCaseAudienceMember({ caseId: kasus.case_id, userId: uid, schoolId: currentUser.school_id, addedByUserId: currentUser.user_id });
                            } else {
                                await removeCaseAudienceMember({ caseId: kasus.case_id, userId: uid });
                            }
                            await loadAudienceMembers(kasus);
                        } catch (err) {
                            if (err?.code === '23505') {
                                await loadAudienceMembers(kasus);
                            } else {
                                cb.checked = !nowChecked;
                                cb.disabled = false;
                                msgEl.style.color = 'var(--color-danger)';
                                msgEl.textContent = fe(err, 's');
                            }
                        }
                    });
                });
            } else {
                subjectPanel.innerHTML = '';
            }
        } else {
            subjectPanel.innerHTML = '';
        }

        // ── Chip staf (kecualikan siswa/ortu yang sudah tampil di subjectPanel) ──
        const staffMembers = members.filter(m => !subjectUidSet.has(m.user_id));
        if (!staffMembers.length) {
            listEl.innerHTML = '<em style="color:var(--color-text-muted)">Belum ada staf yang ditambahkan.</em>';
        } else {
            listEl.innerHTML = staffMembers.map(m => {
                const name = m.users?.full_name ?? m.user_id;
                const role = ROLE_LABEL[m.users?.role_type] ?? m.users?.role_type ?? '';
                return `<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 4px 2px 0;padding:2px 8px;border:1px solid var(--color-border);border-radius:20px;font-size:12px">
                    ${esc(name)} <span style="color:var(--color-text-muted)">(${esc(role)})</span>
                    <button data-uid="${m.user_id}" style="background:none;border:none;cursor:pointer;color:var(--color-danger);font-size:14px;line-height:1;padding:0 2px" title="Hapus">×</button>
                </span>`;
            }).join('');
            listEl.querySelectorAll('button[data-uid]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    try {
                        await removeCaseAudienceMember({ caseId: kasus.case_id, userId: btn.dataset.uid });
                        await loadAudienceMembers(kasus);
                    } catch (err) {
                        msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
                    }
                });
            });
        }
    } catch (err) {
        listEl.textContent = 'Gagal memuat anggota.';
    }

    // Search + add
    let _searchTimer;
    searchEl.oninput = () => {
        clearTimeout(_searchTimer);
        const q = searchEl.value.trim();
        if (q.length < 2) { dropEl.style.display = 'none'; return; }
        _searchTimer = setTimeout(async () => {
            try {
                const rows = await searchInternalUsers(q);
                if (!rows.length) { dropEl.style.display = 'none'; return; }
                dropEl.innerHTML = rows.map(r =>
                    `<div style="padding:8px 12px;cursor:pointer;font-size:13px" data-id="${r.user_id}" data-name="${esc(r.full_name)}">${esc(r.full_name)} — ${esc(ROLE_LABEL[r.role_type] ?? r.role_type)}</div>`
                ).join('');
                dropEl.style.display = 'block';
                dropEl.querySelectorAll('div').forEach(el => {
                    el.addEventListener('click', async () => {
                        dropEl.style.display = 'none';
                        searchEl.value = '';
                        try {
                            await addCaseAudienceMember({ caseId: kasus.case_id, userId: el.dataset.id, schoolId: currentUser.school_id, addedByUserId: currentUser.user_id });
                            await loadAudienceMembers(kasus);
                        } catch (err) {
                            msgEl.style.color = 'var(--color-danger)'; msgEl.textContent = fe(err, 's');
                        }
                    });
                    el.addEventListener('mouseenter', () => { el.style.background = 'var(--color-bg)'; });
                    el.addEventListener('mouseleave', () => { el.style.background = ''; });
                });
            } catch(e) { console.error('[kasus-member-search]', e); dropEl.style.display = 'none'; }
        }, 250);
    };
}

function replaceEl(id) {
    const old = document.getElementById(id);
    if (!old) return { addEventListener: () => {}, style: {}, dataset: {}, disabled: false };
    const neu = old.cloneNode(true);
    old.parentNode.replaceChild(neu, old);
    return neu;
}

async function refreshKasusDetail() {
    if (!_kasusCurrentId) return;
    try {
        const [kasus, events] = await Promise.all([getCase(_kasusCurrentId), getCaseEvents(_kasusCurrentId)]);
        renderKasusDetail(kasus);
        renderKasusEvents(events);
        renderKasusActions(kasus);
        // Update entri di list cache tanpa re-fetch seluruh halaman
        const idx = _kasusAllCases.findIndex(c => c.case_id === _kasusCurrentId);
        if (idx >= 0) _kasusAllCases[idx] = {
            ..._kasusAllCases[idx],
            status:               kasus.status,
            current_handler_role: kasus.current_handler_role,
            is_locked:            kasus.is_locked,
        };
    } catch (err) {
        console.error('[kasus] refresh error', err);
    }
}

// ─── TAB JURNAL MENGAJAR ─────────────────────────────────────

let _jurnalTabInit = false;
async function initJurnalTab() {
    if (_jurnalTabInit) return;
    _jurnalTabInit = true;

    // Tanggal default hari ini, tersembunyi
    const dateEl = document.getElementById('journal-date');
    dateEl.value = localDateStr();

    document.getElementById('journal-date-toggle').addEventListener('click', () => {
        const row = document.getElementById('journal-date-row');
        const visible = row.style.display !== 'none';
        row.style.display = visible ? 'none' : 'block';
    });

    await loadJurnalList();

    document.getElementById('journal-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn     = document.getElementById('journal-submit-btn');
        const msgEl   = document.getElementById('journal-form-msg');
        const content = document.getElementById('journal-content').value.trim();
        const date    = document.getElementById('journal-date').value;

        if (!content) return;

        btn.disabled = true;
        btn.textContent = 'Menyimpan…';
        msgEl.style.display = 'none';

        try {
            const r = await insertJournalEntry(currentUser.user_id, date, content);
            if (r.status === 'error') throw new Error(r.error);
            document.getElementById('journal-content').value = '';
            msgEl.textContent = r.status === 'queued'
                ? '⏳ Catatan disimpan lokal — akan dikirim saat online.'
                : 'Catatan berhasil disimpan.';
            msgEl.style.display = 'block';
            if (r.status === 'queued') {
                const cacheKey = `jurnal-${currentUser.user_id}`;
                const cached   = LC.get(cacheKey) ?? [];
                const newEntry = { journal_id: r.journal_id, entry_date: date, content, created_at: new Date().toISOString() };
                LC.set(cacheKey, [newEntry, ...cached]);
                renderJurnalEntries([newEntry, ...cached], document.getElementById('journal-list'));
            }
            if (r.status === 'synced') await loadJurnalList();
        } catch (err) {
            msgEl.textContent = fe(err, 's');
            msgEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Simpan';
        }
    });
}

function renderJurnalEntries(entries, listEl) {
    if (!entries.length) {
        listEl.innerHTML = '<p class="hint">Belum ada catatan.</p>';
        return;
    }
    listEl.innerHTML = entries.map(e => `
        <div class="section-card" style="margin-bottom:8px" data-entry-id="${esc(e.journal_id)}" data-entry-date="${esc(e.entry_date)}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">
                <strong>${fmt(e.entry_date)}</strong>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                    <div class="jrn-del-confirm" style="display:none;align-items:center;gap:8px">
                        <span style="font-size:13px;color:var(--color-text-muted)">Hapus catatan ini?</span>
                        <button class="btn btn-danger btn-sm jrn-del-yes">Ya, Hapus</button>
                        <button class="btn btn-secondary btn-sm jrn-del-no">Batal</button>
                    </div>
                    <button class="btn btn-secondary btn-sm jrn-edit-btn" data-id="${esc(e.journal_id)}">Edit</button>
                    <button class="btn btn-secondary btn-sm jrn-del-ask" data-delete="${esc(e.journal_id)}">Hapus</button>
                </div>
            </div>
            <p class="jrn-content-view" style="white-space:pre-wrap;margin:0">${esc(e.content)}</p>
            <div class="jrn-edit-area" style="display:none">
                <textarea class="input jrn-edit-ta" rows="4" style="width:100%;margin-bottom:6px">${esc(e.content)}</textarea>
                <div style="display:flex;gap:6px">
                    <button class="btn btn-primary btn-sm jrn-edit-save">Simpan</button>
                    <button class="btn btn-secondary btn-sm jrn-edit-cancel">Batal</button>
                </div>
                <p class="jrn-edit-err" style="display:none;font-size:13px;color:var(--color-danger);margin:4px 0 0"></p>
            </div>
            <p class="jrn-del-err" style="display:none;font-size:13px;color:var(--color-danger);margin:4px 0 0"></p>
        </div>
    `).join('');

    listEl.querySelectorAll('[data-entry-id]').forEach(card => {
        const id        = card.dataset.entryId;
        const entryDate = card.dataset.entryDate;
        const askBtn    = card.querySelector('.jrn-del-ask');
        const confirmEl = card.querySelector('.jrn-del-confirm');
        const yesBtn    = card.querySelector('.jrn-del-yes');
        const noBtn     = card.querySelector('.jrn-del-no');
        const errEl     = card.querySelector('.jrn-del-err');
        const editBtn   = card.querySelector('.jrn-edit-btn');
        const editArea  = card.querySelector('.jrn-edit-area');
        const editTa    = card.querySelector('.jrn-edit-ta');
        const editSave  = card.querySelector('.jrn-edit-save');
        const editCancel= card.querySelector('.jrn-edit-cancel');
        const editErr   = card.querySelector('.jrn-edit-err');
        const contentP  = card.querySelector('.jrn-content-view');

            askBtn.addEventListener('click', () => {
                confirmEl.style.display = 'flex';
                askBtn.style.display    = 'none';
            });
            noBtn.addEventListener('click', () => {
                confirmEl.style.display = 'none';
                askBtn.style.display    = 'inline-flex';
            });
            yesBtn.addEventListener('click', async () => {
                if (!navigator.onLine) {
                    errEl.textContent = 'Hapus tidak tersedia saat offline.';
                    errEl.style.display = 'block';
                    confirmEl.style.display = 'none';
                    askBtn.style.display = 'inline-flex';
                    return;
                }
                yesBtn.disabled = true; yesBtn.textContent = 'Menghapus…';
                try {
                    await deleteJournalEntry(askBtn.dataset.delete);
                    await loadJurnalList();
                } catch (err) {
                    errEl.textContent = fe(err, 'h');
                    errEl.style.display = 'block';
                    yesBtn.disabled = false; yesBtn.textContent = 'Ya, Hapus';
                }
            });

            editBtn.addEventListener('click', () => {
                editArea.style.display  = 'block';
                contentP.style.display  = 'none';
                editBtn.style.display   = 'none';
                askBtn.style.display    = 'none';
                editErr.style.display   = 'none';
            });
            editCancel.addEventListener('click', () => {
                editArea.style.display  = 'none';
                contentP.style.display  = '';
                editBtn.style.display   = '';
                askBtn.style.display    = '';
            });
            editSave.addEventListener('click', async () => {
                const newContent = editTa.value.trim();
                if (!newContent) return;
                editSave.disabled = true; editSave.textContent = 'Menyimpan…';
                try {
                    const r = await updateJournalEntry(id, entryDate, newContent, currentUser.user_id);
                    if (r.status === 'error') throw new Error(r.error);
                    LC.clear(`jurnal-${currentUser.user_id}`);
                    if (r.status === 'queued') {
                        editErr.textContent = '⏳ Tersimpan di perangkat — akan dikirim saat online.';
                        editErr.style.color = 'var(--color-warning,#b45309)';
                        editErr.style.display = 'block';
                        editSave.disabled = false; editSave.textContent = 'Simpan';
                    } else {
                        await loadJurnalList();
                    }
                } catch (err) {
                    editErr.textContent = fe(err, 's');
                    editErr.style.color = 'var(--color-danger)';
                    editErr.style.display = 'block';
                    editSave.disabled = false; editSave.textContent = 'Simpan';
                }
            });
        });
}

async function loadJurnalList() {
    const listEl   = document.getElementById('journal-list');
    const cacheKey = `jurnal-${currentUser.user_id}`;

    // Tampilkan cache dulu
    const cached = LC.get(cacheKey);
    if (cached) {
        renderJurnalEntries(cached, listEl);
    } else {
        listEl.innerHTML = '<p class="hint">Memuat…</p>';
    }

    try {
        const entries = await getJournalEntries(currentUser.user_id);
        LC.set(cacheKey, entries);
        renderJurnalEntries(entries, listEl);
    } catch (err) {
        if (!cached) {
            listEl.innerHTML = `<p class="hint">Gagal memuat data. ${esc(fe(err))}</p>`;
        }
    }
}

// ─── TAB FORUM ───────────────────────────────────────────────

let _forumClassId          = null;
let _forumAcademicYear     = null;
let _forumOffset           = 0;
let _forumHasMore          = false;
let _forumTabInit          = false;
let _forumSelectedStudents = [];
let _forumSelectedCategory = null;
let _forumAllMembers   = [];   // cache kandidat picker orang tertentu
let _forumSpecificUsers = [];  // [{user_id, full_name, role_type}] dipilih
let _forumCategories       = [];
let _forumStudents         = [];

async function initForumTab() {
    if (_forumTabInit) {
        await loadForumPosts();
        return;
    }
    _forumTabInit = true;

    const sel = document.getElementById('forum-class-select');
    sel.innerHTML = '<option value="">Memuat kelas…</option>';
    try {
        const classes = await getForumClasses(currentUser.user_id, config.current_academic_year);
        if (!classes.length) {
            sel.innerHTML = '<option value="">Tidak ada kelas</option>';
            document.getElementById('forum-loading').textContent = 'Anda tidak memiliki kelas yang bisa diakses.';
            return;
        }
        sel.innerHTML = [...classes]
            .sort((a, b) => a.name.localeCompare(b.name, 'id'))
            .map(c => `<option value="${esc(c.class_id)}">${esc(c.name)}</option>`)
            .join('');
        const first = classes[0];
        _forumClassId      = first.class_id;
        _forumAcademicYear = config.current_academic_year;
    } catch (err) {
        sel.innerHTML = '<option value="">Gagal memuat</option>';
        document.getElementById('forum-loading').textContent = fe(err);
        return;
    }

    sel.addEventListener('change', () => {
        _forumClassId      = sel.value || null;
        _forumOffset = 0;
        loadForumPosts();
    });

    document.getElementById('btn-create-post').addEventListener('click', openCreatePostModal);
    document.getElementById('btn-load-more-posts').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        await loadForumPosts(true);
        e.currentTarget.disabled = false;
    });
    document.getElementById('btn-cancel-post').addEventListener('click', closeCreatePostModal);
    document.getElementById('modal-create-post').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeCreatePostModal();
    });
    document.getElementById('btn-submit-post').addEventListener('click', submitCreatePost);
    document.getElementById('forum-audience-select').addEventListener('change', updateAudienceWarning);

    await loadForumPosts();
}

async function loadForumPosts(append = false) {
    const loadingEl = document.getElementById('forum-loading');
    const listEl    = document.getElementById('forum-posts-list');
    const moreBtn   = document.getElementById('btn-load-more-posts');

    if (!_forumClassId) {
        loadingEl.textContent = 'Pilih kelas untuk melihat forum.';
        loadingEl.style.display = 'block';
        listEl.innerHTML = '';
        moreBtn.style.display = 'none';
        return;
    }

    if (!append) {
        _forumOffset = 0;
        listEl.innerHTML = '';
        loadingEl.textContent = 'Memuat forum…';
        loadingEl.style.display = 'block';
    }
    moreBtn.style.display = 'none';

    const LIMIT = 20;
    try {
        // Waka/Kepsek: tampilkan semua posting kelas (tidak filter by audience table).
        // RLS fn_can_read_forum_post tetap menjadi penjaga akses di sisi database.
        const isOversight = ['WAKA_KESISWAAN', 'KEPSEK', 'ADMINISTRATIVE'].includes(currentUser.role_type)
            || currentUser.is_waka_kesiswaan === true
            || currentUser.is_kepsek === true;
        const skipAudienceFilter = isOversight;
        const posts = await getForumPosts(
            _forumClassId, _forumAcademicYear,
            currentUser.user_id, currentUser.school_id,
            LIMIT, _forumOffset, skipAudienceFilter
        );
        loadingEl.style.display = 'none';

        if (!posts.length && !append) {
            listEl.innerHTML = '<p class="hint">Belum ada posting di forum ini.</p>';
            return;
        }

        listEl.insertAdjacentHTML('beforeend', posts.map(renderForumPostCard).join(''));
        _forumOffset += posts.length;
        _forumHasMore = posts.length === LIMIT;
        moreBtn.style.display = _forumHasMore ? 'inline-block' : 'none';

        wireForumCards(listEl, posts);
    } catch (err) {
        loadingEl.textContent = fe(err);
        loadingEl.style.display = 'block';
    }
}

function renderForumPostCard(post) {
    const isWithdrawn = !!post.is_withdrawn;
    const isAuthor    = post.author_user_id === currentUser.user_id;
    const authorName  = post.author?.full_name ?? '—';
    const ts = post.created_at
        ? new Date(post.created_at).toLocaleString('id-ID', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
        : '—';
    const edited = post.updated_at && post.updated_at !== post.created_at
        ? ` <span style="color:var(--color-text-muted);font-size:11px">(diedit)</span>` : '';

    const subjects = (post.subjects ?? []).map(s => s.student?.full_name).filter(Boolean);
    const catLabel  = post.category?.label_sekolah ?? null;
    const catPol    = post.category?.polarity ?? null;
    const catColor  = catPol === 'POSITIVE' ? 'var(--color-success,#4ade80)'
                    : catPol === 'NEGATIVE' ? 'var(--color-danger,#f87171)'
                    : 'var(--color-primary)';

    const ackCount = (post.acknowledgements ?? []).length;
    const cmtCount = (post.comments ?? []).length;
    const hasAcked = (post.acknowledgements ?? []).some(a => a.user_id === currentUser.user_id);

    const canEdit = isAuthor && !isWithdrawn && cmtCount === 0;

    const bodyHtml = isWithdrawn
        ? `<p style="color:var(--color-text-muted);font-style:italic;margin:8px 0">[Posting ini telah ditarik]</p>`
        : `<p style="margin:8px 0;white-space:pre-wrap;color:var(--color-text)">${esc(post.body ?? '')}</p>`;

    return `
    <div class="forum-post-card" data-post-id="${esc(post.post_id)}"
         data-author-id="${esc(post.author_user_id ?? '')}"
         data-withdrawn="${isWithdrawn ? '1' : '0'}"
         data-comment-count="${cmtCount}"
         style="border-bottom:0.5px solid var(--color-border);padding:14px 0${isWithdrawn ? ';opacity:.6' : ''}">

        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px;margin-bottom:4px">
            <strong style="font-size:14px">${esc(authorName)}</strong>
            <span style="font-size:11px;color:var(--color-text-muted)">${ts}${edited}</span>
        </div>

        ${subjects.length ? `<p style="font-size:12px;color:var(--color-text-muted);margin:0 0 4px">Siswa: ${esc(subjects.join(', '))}</p>` : ''}
        ${catLabel ? `<span style="font-size:11px;padding:2px 8px;border-radius:20px;color:${catColor};background:var(--color-bg-alt);margin-bottom:6px;display:inline-block">${esc(catLabel)}</span>` : ''}

        <div class="forum-post-body">${bodyHtml}</div>

        ${!isWithdrawn ? `
        <div class="forum-post-actions" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-sm ${hasAcked ? 'btn-primary' : 'btn-secondary'} btn-ack"
                    style="font-size:12px" data-acked="${hasAcked ? '1' : '0'}">
                ✓ Sudah baca${ackCount > 0 ? ` (${ackCount})` : ''}
            </button>
            <button class="btn btn-sm btn-secondary btn-comments" style="font-size:12px">
                💬 Komentar${cmtCount > 0 ? ` (${cmtCount})` : ''}
            </button>
            ${canEdit ? `<button class="btn btn-sm btn-secondary btn-edit-post" style="font-size:12px">Edit</button>` : ''}
            ${isAuthor ? `<button class="btn btn-sm btn-secondary btn-withdraw" style="font-size:12px;color:var(--color-danger)">Tarik posting</button>` : ''}
        </div>
        <div class="forum-comments-panel" style="display:none;margin-top:12px;padding:10px;background:var(--color-bg-alt);border-radius:var(--radius)">
            <div class="forum-comments-list" style="margin-bottom:8px;font-size:13px"></div>
            <div style="display:flex;gap:6px">
                <input type="text" class="input forum-comment-input" placeholder="Tulis komentar…" maxlength="1000" style="flex:1;font-size:13px">
                <button class="btn btn-primary btn-sm btn-send-comment">Kirim</button>
            </div>
            <p class="forum-comment-err" style="font-size:12px;color:var(--color-danger);margin:4px 0 0;display:none"></p>
        </div>
        ` : ''}
    </div>`;
}

function wireForumCards(containerEl, posts) {
    containerEl.querySelectorAll('.forum-post-card:not([data-wired])').forEach(card => {
        card.dataset.wired = '1';
        const postId      = card.dataset.postId;
        const isWithdrawn = card.dataset.withdrawn === '1';
        if (isWithdrawn) return;

        const ackBtn = card.querySelector('.btn-ack');
        if (ackBtn) {
            ackBtn.addEventListener('click', async () => {
                if (ackBtn.dataset.acked === '1') return;
                ackBtn.disabled = true;
                try {
                    await addForumAcknowledgement(postId, currentUser.user_id, currentUser.school_id);
                    ackBtn.dataset.acked = '1';
                    ackBtn.classList.replace('btn-secondary', 'btn-primary');
                    const cur = parseInt(ackBtn.textContent.match(/\d+/)?.[0] ?? '0', 10);
                    ackBtn.textContent = `✓ Sudah baca (${cur + 1})`;
                } catch (err) {
                    alert(fe(err));
                } finally {
                    ackBtn.disabled = false;
                }
            });
        }

        const cmtBtn   = card.querySelector('.btn-comments');
        const cmtPanel = card.querySelector('.forum-comments-panel');
        if (cmtBtn && cmtPanel) {
            cmtBtn.addEventListener('click', async () => {
                const open = cmtPanel.style.display !== 'none';
                cmtPanel.style.display = open ? 'none' : 'block';
                if (!open) await loadForumComments(postId, cmtPanel);
            });
        }

        const sendBtn  = card.querySelector('.btn-send-comment');
        const cmtInput = card.querySelector('.forum-comment-input');
        const cmtErr   = card.querySelector('.forum-comment-err');
        if (sendBtn && cmtInput) {
            sendBtn.addEventListener('click', async () => {
                const body = cmtInput.value.trim();
                if (!body) return;
                sendBtn.disabled = true; sendBtn.textContent = '…';
                cmtErr.style.display = 'none';
                try {
                    await addForumComment(postId, body, currentUser.user_id, currentUser.school_id);
                    cmtInput.value = '';
                    await loadForumComments(postId, cmtPanel);
                } catch (err) {
                    cmtErr.textContent = fe(err, 's');
                    cmtErr.style.display = 'block';
                } finally {
                    sendBtn.disabled = false; sendBtn.textContent = 'Kirim';
                }
            });
        }

        const editBtn = card.querySelector('.btn-edit-post');
        if (editBtn) {
            editBtn.addEventListener('click', () => handleEditForumPost(card, postId));
        }

        const wdBtn = card.querySelector('.btn-withdraw');
        if (wdBtn) {
            wdBtn.addEventListener('click', async () => {
                const cmtCount = parseInt(card.dataset.commentCount ?? '0', 10);
                const msg = cmtCount > 0
                    ? `Tarik posting ini? Konten akan disembunyikan, tapi ${cmtCount} komentar yang sudah ada tetap terlihat.`
                    : 'Tarik posting ini? Konten akan disembunyikan dari pembaca.';
                if (!confirm(msg)) return;
                wdBtn.disabled = true;
                try {
                    await withdrawForumPost(postId);
                    _forumOffset = 0;
                    await loadForumPosts();
                } catch (err) {
                    alert(fe(err, 's'));
                    wdBtn.disabled = false;
                }
            });
        }
    });
}

function handleEditForumPost(card, postId) {
    const bodyEl   = card.querySelector('.forum-post-body');
    const actionsEl = card.querySelector('.forum-post-actions');
    if (!bodyEl) return;

    // Ambil teks asli dari elemen <p> di dalam body
    const currentText = bodyEl.querySelector('p')?.innerText ?? '';

    const textarea = document.createElement('textarea');
    textarea.className  = 'input';
    textarea.value      = currentText;
    textarea.rows       = 4;
    textarea.maxLength  = 2000;
    textarea.style.cssText = 'width:100%;font-size:14px;margin:4px 0 6px;box-sizing:border-box';

    const saveBtn   = document.createElement('button');
    saveBtn.className   = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Simpan';
    saveBtn.style.marginRight = '6px';
    saveBtn.style.fontSize = '12px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Batal';
    cancelBtn.style.fontSize = '12px';

    const errEl = document.createElement('p');
    errEl.style.cssText = 'color:var(--color-danger);font-size:12px;margin:4px 0 0;display:none';

    bodyEl.innerHTML = '';
    bodyEl.appendChild(textarea);
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(errEl);
    bodyEl.appendChild(btnRow);
    if (actionsEl) actionsEl.style.display = 'none';
    textarea.focus();

    cancelBtn.addEventListener('click', () => {
        _forumOffset = 0;
        loadForumPosts();
    });

    saveBtn.addEventListener('click', async () => {
        const newBody = textarea.value.trim();
        if (newBody.length < 3) {
            errEl.textContent = 'Isi posting minimal 3 karakter.';
            errEl.style.display = 'block';
            return;
        }
        errEl.style.display = 'none';
        saveBtn.disabled    = true;
        saveBtn.textContent = 'Menyimpan…';
        try {
            await updateForumPost(postId, newBody);
            _forumOffset = 0;
            await loadForumPosts();
        } catch (err) {
            errEl.textContent  = fe(err, 's');
            errEl.style.display = 'block';
            saveBtn.disabled    = false;
            saveBtn.textContent = 'Simpan';
        }
    });
}

async function loadForumComments(postId, panel) {
    const listEl = panel.querySelector('.forum-comments-list');
    listEl.innerHTML = '<span style="color:var(--color-text-muted)">Memuat…</span>';
    try {
        const comments = await getForumPostComments(postId);
        if (!comments.length) {
            listEl.innerHTML = '<span style="color:var(--color-text-muted)">Belum ada komentar.</span>';
            return;
        }
        listEl.innerHTML = comments.map(c => {
            const ts = new Date(c.created_at).toLocaleString('id-ID', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
            const isOwn = c.author_user_id === currentUser.user_id;
            return `<div style="margin-bottom:8px;border-bottom:0.5px solid var(--color-border);padding-bottom:8px" data-comment-id="${esc(c.comment_id)}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
                    <span>
                        <span style="font-weight:600;font-size:12px">${esc(c.author?.full_name ?? '—')}</span>
                        <span style="font-size:11px;color:var(--color-text-muted);margin-left:6px">${ts}</span>
                    </span>
                    ${isOwn ? `<button class="btn-del-comment" data-cid="${esc(c.comment_id)}" style="background:none;border:none;cursor:pointer;color:var(--color-danger);font-size:12px;padding:0 2px" title="Hapus komentar">Hapus</button>` : ''}
                </div>
                <p style="margin:4px 0 0;font-size:13px;white-space:pre-wrap">${esc(c.body)}</p>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.btn-del-comment').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Hapus komentar ini?')) return;
                btn.disabled = true;
                try {
                    await withdrawForumComment(btn.dataset.cid);
                    btn.closest('[data-comment-id]').remove();
                } catch (err) {
                    alert(fe(err));
                    btn.disabled = false;
                }
            });
        });
    } catch (err) {
        listEl.innerHTML = `<span style="color:var(--color-danger)">${fe(err)}</span>`;
    }
}

async function openCreatePostModal() {
    _forumSelectedStudents  = [];
    _forumSelectedCategory  = null;
    _forumSpecificUsers     = [];

    const modal = document.getElementById('modal-create-post');
    modal.style.display = 'flex';
    const searchEl = document.getElementById('forum-specific-search');
    if (searchEl) { searchEl.placeholder = 'Ketik nama staf, orang tua, atau nama siswa…'; searchEl.value = ''; }
    document.getElementById('forum-post-content').value = '';
    document.getElementById('forum-post-error').style.display = 'none';
    document.getElementById('forum-category-section').style.display = 'none';
    document.getElementById('forum-audience-warning').style.display = 'none';
    document.getElementById('forum-audience-select').value = 'STAF_SAJA';
    document.getElementById('forum-audience-select-2').value = '';

    const studentListEl = document.getElementById('forum-student-list');
    studentListEl.innerHTML = '<p class="hint" style="margin:0">Memuat…</p>';
    try {
        _forumStudents = await getForumStudents(_forumClassId, _forumAcademicYear);
        if (!_forumStudents.length) {
            studentListEl.innerHTML = '<p class="hint" style="margin:0">Tidak ada siswa di kelas ini.</p>';
        } else {
            renderForumStudentCheckboxes();
        }
    } catch (err) {
        studentListEl.innerHTML = `<p style="color:var(--color-danger);margin:0;font-size:13px">${fe(err)}</p>`;
    }

    if (!_forumCategories.length) {
        try { _forumCategories = await getForumCategories(); } catch { /* non-fatal */ }
    }
    renderForumCategoryGrid();

    // Load kandidat picker orang tertentu (sekali per buka modal)
    _forumAllMembers = [];
    renderSpecificChips();
    initForumSpecificPicker();
    if (_forumClassId) {
        try {
            _forumAllMembers = await getForumMemberDetails(
                _forumClassId, _forumAcademicYear
            );
        } catch (err) {
            const searchEl = document.getElementById('forum-specific-search');
            if (searchEl) searchEl.placeholder = 'Gagal memuat daftar anggota — coba tutup dan buka modal lagi';
        }
    } else {
        const searchEl = document.getElementById('forum-specific-search');
        if (searchEl) searchEl.placeholder = 'Pilih kelas terlebih dahulu';
    }
}

// ─── Forum: picker orang tertentu ────────────────────────

function renderSpecificChips() {
    const chipsEl = document.getElementById('forum-specific-chips');
    if (!chipsEl) return;
    if (!_forumSpecificUsers.length) {
        chipsEl.innerHTML = '';
        return;
    }
    chipsEl.innerHTML = _forumSpecificUsers.map(u => `
        <span style="display:inline-flex;align-items:center;gap:4px;
                     background:var(--color-primary-subtle,#eff6ff);
                     color:var(--color-primary,#2563eb);
                     border:1px solid var(--color-primary-light,#bfdbfe);
                     border-radius:999px;padding:2px 10px 2px 8px;
                     font-size:13px;line-height:1.4">
            ${esc(u.full_name)}
            <button type="button"
                    data-uid="${esc(u.user_id)}"
                    style="background:none;border:none;cursor:pointer;
                           color:inherit;padding:0;font-size:15px;
                           line-height:1;margin-left:2px"
                    aria-label="Hapus ${esc(u.full_name)}">×</button>
        </span>`).join('');
    chipsEl.querySelectorAll('button[data-uid]').forEach(btn => {
        btn.addEventListener('click', () => {
            _forumSpecificUsers = _forumSpecificUsers
                .filter(u => u.user_id !== btn.dataset.uid);
            renderSpecificChips();
        });
    });
}

function initForumSpecificPicker() {
    const searchEl    = document.getElementById('forum-specific-search');
    const dropdownEl  = document.getElementById('forum-specific-dropdown');
    if (!searchEl || !dropdownEl) return;

    // Reset
    searchEl.value   = '';
    dropdownEl.style.display = 'none';
    dropdownEl.innerHTML     = '';

    searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        if (q.length < 1) {
            dropdownEl.style.display = 'none';
            dropdownEl.innerHTML = '';
            return;
        }
        const alreadyIds = new Set(_forumSpecificUsers.map(u => u.user_id));
        const matches = _forumAllMembers.filter(m =>
            !alreadyIds.has(m.user_id) &&
            (m.full_name.toLowerCase().includes(q) ||
             (m.student_name && m.student_name.toLowerCase().includes(q)))
        );
        if (!matches.length) {
            dropdownEl.innerHTML =
                '<div style="padding:10px 12px;font-size:13px;' +
                'color:var(--color-text-muted)">Tidak ditemukan.</div>';
            dropdownEl.style.display = 'block';
            return;
        }
        dropdownEl.innerHTML = matches.slice(0, 10).map(m => {
            const sublabel = m.role_type === 'ORTU' && m.student_name
                ? `Orang tua dari: ${esc(m.student_name)}`
                : esc(m.role_type);
            return `
            <div data-uid="${esc(m.user_id)}"
                 data-name="${esc(m.full_name)}"
                 data-role="${esc(m.role_type)}"
                 data-student="${esc(m.student_name ?? '')}"
                 style="padding:8px 12px;cursor:pointer;font-size:13px;
                        border-bottom:1px solid var(--color-border-subtle,
                        var(--color-border))">
                <span style="font-weight:500">${esc(m.full_name)}</span>
                <span style="color:var(--color-text-muted);
                             margin-left:6px;font-size:11px">
                    ${sublabel}
                </span>
            </div>`;
        }).join('');
        dropdownEl.style.display = 'block';
        dropdownEl.querySelectorAll('div[data-uid]').forEach(item => {
            item.addEventListener('mouseenter', () =>
                item.style.background = 'var(--color-hover,#f1f5f9)');
            item.addEventListener('mouseleave', () =>
                item.style.background = '');
            item.addEventListener('click', () => {
                _forumSpecificUsers.push({
                    user_id:      item.dataset.uid,
                    full_name:    item.dataset.name,
                    role_type:    item.dataset.role,
                    student_name: item.dataset.student || null,
                });
                searchEl.value           = '';
                dropdownEl.style.display = 'none';
                dropdownEl.innerHTML     = '';
                renderSpecificChips();
            });
        });
    });

    // Tutup dropdown jika klik di luar
    document.addEventListener('click', function closeDrop(e) {
        if (!searchEl.contains(e.target) &&
            !dropdownEl.contains(e.target)) {
            dropdownEl.style.display = 'none';
        }
    }, { once: true, capture: false });
}

function closeCreatePostModal() {
    document.getElementById('modal-create-post').style.display = 'none';
}

function renderForumStudentCheckboxes() {
    const el = document.getElementById('forum-student-list');
    el.innerHTML = _forumStudents.map(s =>
        `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:2px 0">
            <input type="checkbox" class="forum-student-cb" value="${esc(s.student_id)}"
                   style="width:15px;height:15px;cursor:pointer">
            ${esc(s.full_name)}<span style="color:var(--color-text-muted);font-size:11px"> ${esc(s.nis ?? '')}</span>
        </label>`
    ).join('');

    el.querySelectorAll('.forum-student-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            _forumSelectedStudents = [...el.querySelectorAll('.forum-student-cb:checked')].map(c => c.value);
            const hasSubjects = _forumSelectedStudents.length > 0;
            document.getElementById('forum-category-section').style.display = hasSubjects ? 'block' : 'none';
            if (!hasSubjects) {
                _forumSelectedCategory = null;
                renderForumCategoryGrid();
            }
            const audienceSel = document.getElementById('forum-audience-select');
            const subjOpt = audienceSel.querySelector('option[value="ORTU_SISWA_SUBJEK"]');
            if (subjOpt) subjOpt.disabled = !hasSubjects;
            if (!hasSubjects && audienceSel.value === 'ORTU_SISWA_SUBJEK') {
                audienceSel.value = 'STAF_SAJA';
            }
            updateAudienceWarning();
        });
    });
}

function renderForumCategoryGrid() {
    const grid = document.getElementById('forum-category-grid');
    if (!_forumCategories.length) { grid.innerHTML = ''; return; }
    grid.innerHTML = _forumCategories.map(cat => {
        const color = cat.polarity === 'POSITIVE' ? 'var(--color-success,#4ade80)'
                    : cat.polarity === 'NEGATIVE' ? 'var(--color-danger,#f87171)'
                    : 'var(--color-primary)';
        const sel = _forumSelectedCategory === cat.category_code;
        return `<button type="button" class="btn btn-sm forum-cat-btn ${sel ? 'btn-primary' : 'btn-secondary'}"
                        data-code="${esc(cat.category_code)}"
                        style="font-size:12px;border-color:${color};${sel ? `background:${color};color:#fff` : `color:${color}`}">
                    ${esc(cat.label_sekolah)}
                </button>`;
    }).join('');

    grid.querySelectorAll('.forum-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const code = btn.dataset.code;
            _forumSelectedCategory = _forumSelectedCategory === code ? null : code;
            renderForumCategoryGrid();
        });
    });
}

function updateAudienceWarning() {
    const val    = document.getElementById('forum-audience-select').value;
    const warnEl = document.getElementById('forum-audience-warning');
    const specificSection = document.getElementById('forum-specific-section');
    if (val === 'ORTU_SISWA_KELAS') {
        warnEl.textContent = 'Posting ini akan terlihat oleh semua siswa dan orang tua di kelas ini.';
        warnEl.style.display = 'block';
        if (specificSection) specificSection.style.display = 'none';
    } else if (val === 'PUBLIK') {
        warnEl.textContent = 'Posting ini terlihat oleh seluruh anggota forum, termasuk siswa dan semua orang tua.';
        warnEl.style.display = 'block';
        if (specificSection) specificSection.style.display = 'none';
    } else if (val === 'ORANG_TERTENTU') {
        warnEl.textContent = 'Posting hanya terlihat oleh orang yang Anda pilih di bawah ini.';
        warnEl.style.display = 'block';
        if (specificSection) specificSection.style.display = 'block';
    } else {
        warnEl.style.display = 'none';
        if (specificSection) specificSection.style.display = 'block';
    }
}

async function submitCreatePost() {
    const errEl     = document.getElementById('forum-post-error');
    const submitBtn = document.getElementById('btn-submit-post');
    const content   = document.getElementById('forum-post-content').value.trim();
    const audience  = document.getElementById('forum-audience-select').value;
    const audienceType2 = document.getElementById('forum-audience-select-2')?.value || null;
    const specificUserIds2 = audienceType2 === 'ORANG_TERTENTU'
        ? (_forumSpecificUsers2 ?? []).map(u => u.user_id)
        : [];

    errEl.style.display = 'none';

    if (!content) {
        errEl.textContent = 'Isi catatan tidak boleh kosong.';
        errEl.style.display = 'block';
        return;
    }
    if (audience === 'ORTU_SISWA_SUBJEK' && !_forumSelectedStudents.length) {
        errEl.textContent = 'Audiens "Orang tua & siswa yang dibahas" memerlukan minimal satu siswa dipilih.';
        errEl.style.display = 'block';
        return;
    }
    if (audience === 'ORANG_TERTENTU' && !_forumSpecificUsers.length) {
        errEl.textContent = 'Pilih setidaknya satu orang sebagai penerima.';
        errEl.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Menyimpan…';
    try {
        await createForumPost(
            _forumClassId, _forumAcademicYear,
            content || null,
            _forumSelectedCategory,
            _forumSelectedStudents,
            audience,
            _forumSpecificUsers.map(u => u.user_id),
            audienceType2,
            specificUserIds2
        );
        closeCreatePostModal();
        _forumOffset = 0;
        await loadForumPosts();
    } catch (err) {
        errEl.textContent = fe(err, 's');
        errEl.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Simpan';
    }
}

// ─── Logout ──────────────────────────────────────────────────

// ── Lonceng notifikasi ────────────────────────────────────────
document.getElementById('notif-bell-btn')?.addEventListener('click', openNotifDropdown);

// Tutup dropdown jika klik di luar
document.addEventListener('click', (e) => {
    const panel = document.getElementById('notif-dropdown');
    if (!panel || panel.style.display === 'none') return;
    if (!e.target.closest('#notif-bell-btn') && !e.target.closest('#notif-dropdown')) {
        panel.style.display = 'none';
    }
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
    // Cek antrian tertunda — peringatkan jika ada yang belum tersinkron
    const n = await pendingCount().catch(() => 0);
    if (n > 0) {
        const el = document.getElementById('sync-banner');
        if (el) {
            el.style.background  = 'var(--color-danger-bg,#fef2f2)';
            el.style.color       = 'var(--color-danger,#dc2626)';
            el.style.borderColor = 'var(--color-danger,#dc2626)';
            el.textContent       = `⚠️ ${n} item belum tersinkron akan dihapus saat logout. Pastikan online dulu sebelum keluar.`;
            el.style.display     = 'block';
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    await clearOfflineQueue();
    LC.clear('');   // hapus semua cache smkhr:* dari localStorage
    await logout();
    window.location.replace(getLoginUrl());
});

// ─── PERANGKAT AJAR (Sprint 2) ────────────────────────────────

const DOC_TYPE_LABEL = {
    PROGRAM_TAHUNAN:   'Program Tahunan',
    PROGRAM_SEMESTER:  'Program Semester',
    ATP:               'ATP',
    PPM:               'PPM',
    LKPD:             'LKPD',
    SOAL:             'Soal',
    RUBRIK:           'Rubrik',
};

const DOC_STATUS_LABEL = {
    AI_DRAFT:          'Draft',
    DIREVIEW_GURU:     'Sudah Direview',
    MENUNGGU_WAKA:     'Menunggu Waka Kurikulum',
    DISAHKAN_WAKA:     'Disahkan Waka Kurikulum',
};

const DOC_STATUS_COLOR = {
    AI_DRAFT:          'var(--color-text-muted)',
    DIREVIEW_GURU:     'var(--color-primary)',
    MENUNGGU_WAKA:     'var(--color-warning,#f59e0b)',
    DISAHKAN_WAKA:     'var(--color-success,#16a34a)',
};

function getCurrentAcademicYear() {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth() + 1;
    return month >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

// Cache core subjects agar tidak query ulang setiap kali buka modal
let _coreSubjectsCache = null;

async function ensureCoreSubjects() {
    if (_coreSubjectsCache) return _coreSubjectsCache;
    try {
        _coreSubjectsCache = await getCoreSubjectsDirect();
    } catch {
        _coreSubjectsCache = [];
    }
    return _coreSubjectsCache;
}

let _paTabInit = false;

async function initPerangkatAjarTab() {
    if (_paTabInit) {
        // Refresh data setiap kali tab dibuka (tapi jangan re-wire events)
        await loadPerangkatAjarDashboard();
        return;
    }
    _paTabInit = true;
    await loadPerangkatAjarDashboard();

    // Wire tombol buat dokumen baru (header)
    document.getElementById('pa-new-doc-btn')?.addEventListener('click', () => openBuatDokumenModal(null));
}

async function loadPerangkatAjarDashboard() {
    const container = document.getElementById('perangkat-ajar-container');
    container.innerHTML = `
        <div class="pa-header" style="margin-bottom:16px">
            <h3 style="margin:0 0 10px">Perangkat Ajar Saya</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
                <button class="btn btn-secondary btn-sm" id="btn-profil-mengajar">1. Profil Mengajar</button>
                <button class="btn btn-secondary btn-sm" id="btn-konteks-kelas">2. Konteks Kelas</button>
                <button class="btn btn-primary btn-sm" id="pa-new-doc-btn">+ Buat Dokumen</button>
            </div>
        </div>
        <div id="pa-mapel-list"><p class="hint">Memuat...</p></div>`;

    document.getElementById('pa-new-doc-btn').addEventListener('click', () => openBuatDokumenModal(null));
    document.getElementById('btn-profil-mengajar').addEventListener('click', () => openProfilMengajarModal());
    document.getElementById('btn-konteks-kelas').addEventListener('click', () => openKonteksKelasModal());

    const ay = config?.current_academic_year ?? getCurrentAcademicYear();

    try {
        const [docs, coreSubjects, phases] = await Promise.all([
            getMyTeacherDocuments(currentUser.school_id, ay),
            ensureCoreSubjects(),
            getCorePhases(),
        ]);

        const subjectMap = new Map(coreSubjects.map(s => [s.subject_id, s]));
        const phaseMap   = new Map(phases.map(p => [p.phase_id, p]));

        // Group docs by core_subject_id+phase_id
        const grouped = new Map();
        for (const doc of docs) {
            const key = `${doc.core_subject_id}__${doc.phase_id}`;
            if (!grouped.has(key)) grouped.set(key, { core_subject_id: doc.core_subject_id, phase_id: doc.phase_id, docs: [] });
            grouped.get(key).docs.push(doc);
        }

        const listEl = document.getElementById('pa-mapel-list');
        if (grouped.size === 0) {
            listEl.innerHTML = `
                <div class="section-card" style="text-align:center;padding:32px 16px;color:var(--color-text-muted)">
                    <div style="font-size:32px;margin-bottom:8px">📚</div>
                    <p style="margin:0">Belum ada perangkat ajar yang dibuat.</p>
                </div>`;
            return;
        }

        listEl.innerHTML = [...grouped.values()].map(group => {
            const subj  = subjectMap.get(group.core_subject_id);
            const phase = phaseMap.get(group.phase_id);
            const subjName  = subj?.name ?? '—';
            const phaseName = phase?.code ? `Fase ${phase.code}` : '—';

            // Hitung progress
            const doneStatuses = ['DIREVIEW_GURU', 'DISAHKAN_WAKA'];
            const hasPT  = group.docs.some(d => d.document_type === 'PROGRAM_TAHUNAN'  && doneStatuses.includes(d.status));
            const hasPS1 = group.docs.some(d => d.document_type === 'PROGRAM_SEMESTER' && d.semester === 1 && doneStatuses.includes(d.status));
            const hasPS2 = group.docs.some(d => d.document_type === 'PROGRAM_SEMESTER' && d.semester === 2 && doneStatuses.includes(d.status));
            const hasATP = group.docs.some(d => d.document_type === 'ATP'              && doneStatuses.includes(d.status));
            const pct    = (hasPT ? 10 : 0) + (hasPS1 ? 10 : 0) + (hasPS2 ? 10 : 0) + (hasATP ? 20 : 0)
                         + (group.docs.some(d => d.document_type === 'PPM' && doneStatuses.includes(d.status)) ? 50 : 0);

            const dokRows = ['PROGRAM_TAHUNAN','PROGRAM_SEMESTER','ATP','PPM','LKPD','SOAL','RUBRIK'].map(dtype => {
                const typeDocs = group.docs.filter(d => d.document_type === dtype);
                const badgeHtml = typeDocs.length
                    ? `<span style="font-size:11px;color:var(--color-success,#16a34a)">✓ Ada</span>`
                    : `<span style="font-size:11px;color:var(--color-text-muted)">—</span>`;
                return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:13px">
                    <span>${esc(DOC_TYPE_LABEL[dtype] ?? dtype)}</span>
                    ${badgeHtml}
                </div>`;
            }).join('');

            return `
            <div class="section-card" style="margin-bottom:12px">
                <div style="margin-bottom:12px">
                    <h4 style="margin:0 0 4px">${esc(subjName)}</h4>
                    <span style="font-size:12px;padding:2px 8px;border-radius:12px;background:var(--color-bg-alt);color:var(--color-text-muted)">${esc(phaseName)}</span>
                </div>
                <div style="margin-bottom:10px">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                        <span style="font-size:12px;color:var(--color-text-muted)">Progress</span>
                        <span style="font-size:12px;font-weight:600;color:${pct >= 70 ? 'var(--color-success,#16a34a)' : pct >= 30 ? 'var(--color-warning,#f59e0b)' : 'var(--color-text-muted)'}">${pct}%</span>
                    </div>
                    <div style="height:6px;background:var(--color-bg-alt);border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:${pct >= 70 ? 'var(--color-success,#16a34a)' : pct >= 30 ? 'var(--color-warning,#f59e0b)' : 'var(--color-primary)'};border-radius:3px;transition:width .3s"></div>
                    </div>
                </div>
                <div style="border-top:1px solid var(--color-border);padding-top:10px">${dokRows}</div>
                <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap" id="pa-doc-actions-${esc(group.core_subject_id)}-${esc(group.phase_id)}">
                    ${group.docs.slice(0, 3).map(doc => {
                        const lbl = DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type;
                        const col = DOC_STATUS_COLOR[doc.status] ?? 'inherit';
                        const sem = doc.semester ? ` S${doc.semester}` : '';
                        return `<button class="btn btn-secondary btn-sm pa-detail-btn"
                            data-doc-id="${esc(doc.doc_id)}"
                            data-subject-id="${esc(group.core_subject_id)}"
                            data-phase-id="${esc(group.phase_id)}"
                            style="font-size:12px">
                            ${esc(lbl)}${esc(sem)}
                            <span style="font-size:10px;color:${col};margin-left:4px">${esc(DOC_STATUS_LABEL[doc.status] ?? doc.status)}</span>
                        </button>`;
                    }).join('')}
                    ${group.docs.length > 3 ? `<span style="font-size:12px;color:var(--color-text-muted);align-self:center">+${group.docs.length - 3} lainnya</span>` : ''}
                    <button class="btn btn-primary btn-sm pa-generate-atp-btn"
                        data-core-subject-id="${esc(group.core_subject_id)}"
                        data-phase-id="${esc(group.phase_id)}"
                        data-subject-name="${esc(subjectMap.get(group.core_subject_id)?.name ?? '')}"
                        style="font-size:12px;margin-left:auto">
                        ✨ Generate ATP
                    </button>
                </div>
            </div>`;
        }).join('');

        // Wire event delegation untuk tombol Detail
        document.getElementById('pa-mapel-list').addEventListener('click', e => {
            const detailBtn = e.target.closest('.pa-detail-btn');
            if (detailBtn) {
                openDetailDokumenModal(detailBtn.dataset.docId, detailBtn.dataset.subjectId, detailBtn.dataset.phaseId);
            }
            const genBtn = e.target.closest('.pa-generate-atp-btn');
            if (genBtn) {
                openConfirmGenerateModal(
                    genBtn.dataset.coreSubjectId,
                    genBtn.dataset.phaseId,
                    genBtn.dataset.subjectName,
                    ay,
                );
            }
        });

    } catch (err) {
        document.getElementById('pa-mapel-list').innerHTML =
            `<div class="status-err">Gagal memuat. ${esc(fe(err))}</div>`;
    }
}

async function openBuatDokumenModal(preselect) {
    const modal = document.getElementById('buat-dokumen-modal');
    const body  = document.getElementById('buat-dok-body');
    document.getElementById('buat-dok-title').textContent = 'Buat Dokumen';

    const ay = config?.current_academic_year ?? getCurrentAcademicYear();

    const [coreSubjects, phases] = await Promise.all([
        ensureCoreSubjects(),
        getCorePhases(),
    ]);

    // Check apakah ATP sudah ada untuk subject+phase yang dipilih
    let existingDocs = [];
    if (preselect?.coreSubjectId) {
        try {
            const allDocs = await getMyTeacherDocuments(currentUser.school_id, ay);
            existingDocs = allDocs.filter(d => d.core_subject_id === preselect.coreSubjectId && d.phase_id === preselect.phaseId);
        } catch { /* ignore */ }
    }

    const subjectOptions = coreSubjects.map(s =>
        `<option value="${esc(s.subject_id)}" ${preselect?.coreSubjectId === s.subject_id ? 'selected' : ''}>${esc(s.name)}</option>`
    ).join('');

    const phaseOptions = phases.map(p =>
        `<option value="${esc(p.phase_id)}" ${preselect?.phaseId === p.phase_id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');

    body.innerHTML = `
        <div class="field">
            <label for="buat-dok-subject">Mata Pelajaran</label>
            <select id="buat-dok-subject" class="input">
                <option value="">— Pilih Mata Pelajaran —</option>
                ${subjectOptions}
            </select>
        </div>
        <div class="field">
            <label for="buat-dok-phase">Fase</label>
            <select id="buat-dok-phase" class="input">
                ${phaseOptions}
            </select>
        </div>
        <div class="field">
            <label for="buat-dok-type">Jenis Dokumen</label>
            <select id="buat-dok-type" class="input">
                <option value="">— Pilih Jenis —</option>
                <option value="PROGRAM_TAHUNAN">① Program Tahunan</option>
                <option value="PROGRAM_SEMESTER">② Program Semester</option>
                <option value="ATP">③ ATP (Alur Tujuan Pembelajaran)</option>
                <option value="PPM">④ PPM (Perencanaan Pelaksanaan Modul)</option>
                <option value="LKPD">⑤ LKPD</option>
                <option value="SOAL">⑥ Soal</option>
                <option value="RUBRIK">⑦ Rubrik</option>
            </select>
        </div>
        <div class="field" id="buat-dok-semester-field" style="display:none">
            <label for="buat-dok-semester">Semester</label>
            <select id="buat-dok-semester" class="input">
                <option value="1">Semester 1</option>
                <option value="2">Semester 2</option>
            </select>
        </div>
        <div class="field">
            <label for="buat-dok-judul">Judul Dokumen</label>
            <input type="text" id="buat-dok-judul" class="input" placeholder="Contoh: Program Tahunan Matematika Fase E 2026/2027" maxlength="200">
        </div>
        <div class="field">
            <label for="buat-dok-catatan">Catatan <span style="font-weight:400;color:var(--color-text-muted)">(opsional)</span></label>
            <textarea id="buat-dok-catatan" class="input" rows="3" placeholder="Catatan tambahan..."></textarea>
        </div>
        <div id="buat-dok-warning" style="display:none;padding:8px 12px;background:var(--color-warning-bg,#fffbeb);border:1px solid var(--color-warning,#f59e0b);border-radius:6px;font-size:13px;margin-bottom:12px"></div>
        <div id="buat-dok-msg" style="display:none" class="hint"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button id="buat-dok-cancel" class="btn btn-secondary">Batal</button>
            <button id="buat-dok-submit" class="btn btn-primary">Simpan</button>
        </div>`;

    // Tampilkan/sembunyikan semester field
    document.getElementById('buat-dok-type').addEventListener('change', e => {
        const needSem = ['PROGRAM_SEMESTER','PPM','LKPD','SOAL','RUBRIK'].includes(e.target.value);
        document.getElementById('buat-dok-semester-field').style.display = needSem ? '' : 'none';
        // Warning jika ATP belum ada
        const warnEl = document.getElementById('buat-dok-warning');
        const subjectId = document.getElementById('buat-dok-subject').value;
        const phaseId   = document.getElementById('buat-dok-phase').value;
        const needsAtp  = ['PPM','LKPD','SOAL','RUBRIK'].includes(e.target.value);
        if (needsAtp && subjectId) {
            const hasAtp = existingDocs.some(d => d.document_type === 'ATP');
            if (!hasAtp) {
                warnEl.innerHTML = '⚠ ATP belum ada untuk mapel ini. Disarankan buat ATP dulu agar PPM/LKPD lebih terstruktur.';
                warnEl.style.display = '';
                return;
            }
        }
        warnEl.style.display = 'none';
    });

    document.getElementById('buat-dok-cancel').onclick = () => { modal.style.display = 'none'; };
    document.getElementById('buat-dok-close').onclick  = () => { modal.style.display = 'none'; };

    document.getElementById('buat-dok-submit').onclick = async () => {
        const btn    = document.getElementById('buat-dok-submit');
        const msgEl  = document.getElementById('buat-dok-msg');
        const subjId = document.getElementById('buat-dok-subject').value;
        const phId   = document.getElementById('buat-dok-phase').value;
        const dtype  = document.getElementById('buat-dok-type').value;
        const judul  = document.getElementById('buat-dok-judul').value.trim();
        const catatan= document.getElementById('buat-dok-catatan').value.trim();
        const semEl  = document.getElementById('buat-dok-semester');
        const sem    = ['PROGRAM_SEMESTER','PPM','LKPD','SOAL','RUBRIK'].includes(dtype) ? parseInt(semEl.value, 10) : null;

        if (!subjId || !phId || !dtype) {
            msgEl.style.color   = 'var(--color-danger)';
            msgEl.textContent   = 'Pilih mata pelajaran, fase, dan jenis dokumen.';
            msgEl.style.display = '';
            return;
        }
        btn.disabled    = true;
        btn.textContent = 'Menyimpan…';
        msgEl.style.display = 'none';

        try {
            await createTeacherDocument({
                schoolId:       currentUser.school_id,
                academicYear:   ay,
                documentType:   dtype,
                coreSubjectId:  subjId,
                phaseId:        phId,
                programId:      null,
                scopeType:      'SEMUA_KELAS',
                semester:       sem,
                tpUrutan:       null,
                contentJson:    { judul, catatan },
            });
            msgEl.style.color   = 'var(--color-success,#16a34a)';
            msgEl.textContent   = '✓ Dokumen berhasil disimpan.';
            msgEl.style.display = '';
            setTimeout(async () => {
                modal.style.display = 'none';
                await loadPerangkatAjarDashboard();
            }, 900);
        } catch (err) {
            msgEl.style.color   = 'var(--color-danger)';
            msgEl.textContent   = `✗ ${fe(err, 's')}`;
            msgEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Simpan';
        }
    };

    modal.style.display = 'flex';
}

async function openDetailDokumenModal(docId, coreSubjectId, phaseId) {
    const modal = document.getElementById('buat-dokumen-modal');
    const body  = document.getElementById('buat-dok-body');
    document.getElementById('buat-dok-title').textContent = 'Detail Dokumen';

    body.innerHTML = '<p class="hint">Memuat...</p>';
    modal.style.display = 'flex';
    document.getElementById('buat-dok-close').onclick = () => { modal.style.display = 'none'; };

    const ay = config?.current_academic_year ?? getCurrentAcademicYear();
    try {
        const allDocs = await getMyTeacherDocuments(currentUser.school_id, ay);
        const doc = allDocs.find(d => d.doc_id === docId);
        if (!doc) { body.innerHTML = '<p style="color:var(--color-danger)">Dokumen tidak ditemukan.</p>'; return; }

        const judul   = doc.content_json?.judul   ?? '—';
        const catatan = doc.content_json?.catatan ?? '';
        const dtype   = DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type;
        const semLabel= doc.semester ? ` · Semester ${doc.semester}` : '';
        const statusCol = DOC_STATUS_COLOR[doc.status] ?? 'inherit';

        // Status transitions untuk tombol
        const isOwn = true; // RLS sudah jamin hanya dokumen milik sendiri
        const canMarkReview  = isOwn && doc.status === 'AI_DRAFT';
        const canSubmitWaka  = isOwn && doc.status === 'DIREVIEW_GURU';
        const canDraftBack   = isOwn && doc.status === 'DIREVIEW_GURU';

        body.innerHTML = `
            <div style="margin-bottom:16px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
                    <span style="font-weight:600;font-size:15px">${esc(dtype)}${esc(semLabel)}</span>
                    <span style="font-size:12px;padding:2px 10px;border-radius:20px;color:${statusCol};background:var(--color-bg-alt)">${esc(DOC_STATUS_LABEL[doc.status] ?? doc.status)}</span>
                </div>
                <p style="margin:0 0 6px;font-size:13px"><strong>Judul:</strong> ${esc(judul)}</p>
                ${catatan ? `<p style="margin:0;font-size:13px;color:var(--color-text-muted)"><strong>Catatan:</strong> ${esc(catatan)}</p>` : ''}
                <p style="margin:8px 0 0;font-size:12px;color:var(--color-text-muted)">Dibuat: ${fmt(doc.created_at)}</p>
            </div>

            <div style="border-top:1px solid var(--color-border);padding-top:12px">
                <p style="font-size:12px;color:var(--color-text-muted);margin:0 0 10px">Ubah status dokumen:</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    ${canDraftBack  ? `<button class="btn btn-secondary btn-sm" id="doc-to-draft">Simpan sebagai Draft</button>` : ''}
                    ${canMarkReview ? `<button class="btn btn-secondary btn-sm" id="doc-to-review">Tandai Sudah Direview</button>` : ''}
                    ${canSubmitWaka ? `<button class="btn btn-primary btn-sm" id="doc-to-waka">Ajukan ke Waka Kurikulum</button>` : ''}
                    ${doc.status === 'DISAHKAN_WAKA' ? `<span style="font-size:13px;color:var(--color-success,#16a34a)">✓ Sudah disahkan Waka Kurikulum</span>` : ''}
                    ${doc.status === 'MENUNGGU_WAKA'  ? `<span style="font-size:13px;color:var(--color-warning,#f59e0b)">⏳ Menunggu persetujuan Waka Kurikulum...</span>` : ''}
                </div>
                <div id="doc-status-msg" style="display:none;margin-top:8px;font-size:13px"></div>
            </div>
            ${doc.status !== 'DISAHKAN_WAKA' ? `
            <div style="border-top:1px solid var(--color-border);padding-top:12px;margin-top:12px">
                <button id="btn-hapus-dokumen" class="btn btn-danger-outline btn-sm" data-doc-id="${doc.doc_id}">
                    🗑 Hapus Dokumen
                </button>
            </div>` : ''}`;

        const showMsg = (text, isErr = false) => {
            const el = document.getElementById('doc-status-msg');
            el.textContent   = text;
            el.style.color   = isErr ? 'var(--color-danger)' : 'var(--color-success,#16a34a)';
            el.style.display = '';
        };

        const doStatusChange = async (newStatus, btn) => {
            btn.disabled    = true;
            btn.textContent = '…';
            try {
                await updateDocumentStatus(docId, newStatus);
                showMsg(`✓ Status diubah ke: ${DOC_STATUS_LABEL[newStatus]}`);
                setTimeout(async () => {
                    modal.style.display = 'none';
                    await loadPerangkatAjarDashboard();
                }, 900);
            } catch (err) {
                showMsg(`✗ ${fe(err, 's')}`, true);
                btn.disabled    = false;
                btn.textContent = btn.dataset.label;
            }
        };

        document.getElementById('doc-to-draft')?.addEventListener('click', e => {
            e.target.dataset.label = e.target.textContent;
            doStatusChange('AI_DRAFT', e.target);
        });
        document.getElementById('doc-to-review')?.addEventListener('click', e => {
            e.target.dataset.label = e.target.textContent;
            doStatusChange('DIREVIEW_GURU', e.target);
        });
        document.getElementById('doc-to-waka')?.addEventListener('click', e => {
            e.target.dataset.label = e.target.textContent;
            doStatusChange('MENUNGGU_WAKA', e.target);
        });

        document.getElementById('btn-hapus-dokumen')?.addEventListener('click', async e => {
            if (!confirm('Hapus dokumen ini? Tindakan tidak bisa dibatalkan.')) return;
            const btn = e.target;
            btn.disabled    = true;
            btn.textContent = '…';
            try {
                await deleteTeacherDocument(docId);
                modal.style.display = 'none';
                await loadPerangkatAjarDashboard();
                alert('Dokumen berhasil dihapus.');
            } catch (err) {
                showMsg(`✗ ${fe(err, 's')}`, true);
                btn.disabled    = false;
                btn.textContent = '🗑 Hapus Dokumen';
            }
        });

    } catch (err) {
        body.innerHTML = `<p style="color:var(--color-danger)">Gagal memuat: ${esc(err.message)}</p>`;
    }
}

// Dipanggil dari initWakaKurTab — approval & riwayat untuk Waka Kurikulum
async function loadWakaDocApprovals() {
    const section = document.getElementById('kepsek-approval-section');
    if (!section) return;

    const listEl = document.getElementById('kepsek-approval-list');
    listEl.innerHTML = '<p class="hint">Memuat...</p>';

    try {
        const [docs, history, phases] = await Promise.all([
            getPendingDocApprovals(currentUser.school_id),
            getWakaApprovalHistory(currentUser.school_id),
            getCorePhases(),
        ]);
        const phaseMap = new Map(phases.map(p => [p.phase_id, p]));

        let html = '';

        // ── Bagian 1: Menunggu Persetujuan ──────────────────────
        html += `<h4 style="margin:0 0 10px;font-size:14px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em">Menunggu Persetujuan</h4>`;
        if (!docs.length) {
            html += '<p class="hint" style="margin-bottom:16px">Tidak ada dokumen yang menunggu persetujuan.</p>';
        } else {
            html += docs.map(doc => {
                const dtype    = DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type;
                const phase    = phaseMap.get(doc.phase_id);
                const semLabel = doc.semester ? ` · Semester ${doc.semester}` : '';
                const judul    = doc.content_json?.judul ?? '—';
                return `
                <div style="border:1px solid var(--color-border);border-radius:var(--radius);padding:12px;margin-bottom:10px">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px">
                        <div>
                            <p style="margin:0 0 4px;font-weight:600">${esc(dtype)}${esc(semLabel)}</p>
                            <p style="margin:0 0 4px;font-size:13px">${esc(judul)}</p>
                            <p style="margin:0;font-size:12px;color:var(--color-text-muted)">${phase ? `Fase ${phase.code}` : ''} · ${doc.academic_year} · ${fmt(doc.created_at)}</p>
                        </div>
                        <div style="display:flex;gap:6px;align-items:center">
                            <button class="btn btn-sm btn-secondary wk-reject-btn" data-doc-id="${esc(doc.doc_id)}" style="color:var(--color-danger)">✕ Kembalikan</button>
                            <button class="btn btn-sm btn-primary wk-approve-btn" data-doc-id="${esc(doc.doc_id)}">✓ Setujui</button>
                        </div>
                    </div>
                    <div id="wk-approve-msg-${esc(doc.doc_id)}" style="display:none;font-size:13px;margin-top:8px"></div>
                    <div id="wk-catatan-row-${esc(doc.doc_id)}" style="display:none;margin-top:8px">
                        <input type="text" class="input" placeholder="Catatan pengembalian (opsional)..." style="width:100%;margin-bottom:6px">
                        <button class="btn btn-sm btn-danger wk-reject-confirm-btn" data-doc-id="${esc(doc.doc_id)}">Konfirmasi Kembalikan</button>
                    </div>
                </div>`;
            }).join('');
        }

        // ── Bagian 2: Riwayat ───────────────────────────────────
        html += `<h4 style="margin:16px 0 10px;font-size:14px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em">Riwayat</h4>`;
        if (!history.length) {
            html += '<p class="hint">Belum ada riwayat persetujuan.</p>';
        } else {
            html += history.map(row => {
                const td          = row.teacher_documents;
                const dtype       = DOC_TYPE_LABEL[td?.document_type] ?? td?.document_type ?? '—';
                const phase       = phaseMap.get(td?.phase_id);
                const semLabel    = td?.semester ? ` · Semester ${td.semester}` : '';
                const isOk        = row.status === 'APPROVED';
                const badge       = isOk
                    ? `<span style="color:var(--color-success,#16a34a);font-weight:600">✅ Disahkan</span>`
                    : `<span style="color:var(--color-primary);font-weight:600">↩ Dikembalikan</span>`;
                const subjectHtml = row.subject_name
                    ? `<p style="margin:2px 0 0;font-size:12px;color:var(--color-text-muted)">Mapel: ${esc(row.subject_name)}</p>`
                    : '';
                const guruHtml    = row.teacher_name
                    ? `<p style="margin:2px 0 0;font-size:12px;color:var(--color-text-muted)">Guru: ${esc(row.teacher_name)}</p>`
                    : '';
                const catatanHtml = row.catatan
                    ? `<p style="margin:4px 0 0;font-size:12px;color:var(--color-text-muted);font-style:italic">"${esc(row.catatan)}"</p>`
                    : '';
                const metaLine = [phase ? `Fase ${phase.code}` : '', td?.academic_year ?? '', fmt(row.approved_at)]
                    .filter(Boolean).join(' · ');
                return `
                <div style="border:1px solid var(--color-border);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px;opacity:.9">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap">
                        <div>
                            <p style="margin:0 0 2px;font-weight:600;font-size:13px">${esc(dtype)}${esc(semLabel)}</p>
                            ${subjectHtml}
                            ${guruHtml}
                            <p style="margin:2px 0 0;font-size:12px;color:var(--color-text-muted)">${metaLine}</p>
                            ${catatanHtml}
                        </div>
                        <div>${badge}</div>
                    </div>
                </div>`;
            }).join('');
        }

        listEl.innerHTML = html;

        listEl.addEventListener('click', async e => {
            const approveBtn = e.target.closest('.wk-approve-btn');
            const rejectBtn  = e.target.closest('.wk-reject-btn');
            const confirmBtn = e.target.closest('.wk-reject-confirm-btn');

            if (approveBtn) {
                const docId = approveBtn.dataset.docId;
                approveBtn.disabled    = true;
                approveBtn.textContent = '…';
                const msgEl = document.getElementById(`wk-approve-msg-${docId}`);
                try {
                    await supabase.auth.refreshSession();
                    await wakaApproveDoc(docId, 'APPROVE', null);
                    msgEl.style.color   = 'var(--color-success,#16a34a)';
                    msgEl.textContent   = '✓ Dokumen berhasil disahkan.';
                    msgEl.style.display = '';
                    setTimeout(() => loadWakaDocApprovals(), 1200);
                } catch (err) {
                    msgEl.style.color   = 'var(--color-danger)';
                    msgEl.textContent   = `✗ ${fe(err, 's')}`;
                    msgEl.style.display = '';
                    approveBtn.disabled    = false;
                    approveBtn.textContent = '✓ Setujui';
                }
            }

            if (rejectBtn) {
                const docId = rejectBtn.dataset.docId;
                const row   = document.getElementById(`wk-catatan-row-${docId}`);
                row.style.display = row.style.display === 'none' ? '' : 'none';
            }

            if (confirmBtn) {
                const docId   = confirmBtn.dataset.docId;
                const row     = document.getElementById(`wk-catatan-row-${docId}`);
                const catatan = row.querySelector('input')?.value.trim() ?? null;
                confirmBtn.disabled    = true;
                confirmBtn.textContent = '…';
                const msgEl = document.getElementById(`wk-approve-msg-${docId}`);
                try {
                    await supabase.auth.refreshSession();
                    await wakaApproveDoc(docId, 'REJECT', catatan);
                    msgEl.style.color   = 'var(--color-primary)';
                    msgEl.textContent   = '↩ Dokumen dikembalikan ke guru.';
                    msgEl.style.display = '';
                    setTimeout(() => loadWakaDocApprovals(), 1200);
                } catch (err) {
                    msgEl.style.color   = 'var(--color-danger)';
                    msgEl.textContent   = `✗ ${fe(err, 's')}`;
                    msgEl.style.display = '';
                    confirmBtn.disabled    = false;
                    confirmBtn.textContent = 'Konfirmasi Kembalikan';
                }
            }
        });

    } catch (err) {
        listEl.innerHTML = `<div class="status-err">Gagal memuat. ${esc(fe(err))}</div>`;
    }
}

// Dipanggil dari initKepsekTab — daftar dokumen DISAHKAN_WAKA (read-only)
async function loadKepsekDisahkanDocs() {
    const section = document.getElementById('ks-disahkan-section');
    if (!section) return;

    const listEl = document.getElementById('ks-disahkan-list');
    listEl.innerHTML = '<p class="hint">Memuat...</p>';

    try {
        const [docs, phases] = await Promise.all([
            getDisahkanWakaDocs(currentUser.school_id),
            getCorePhases(),
        ]);
        const phaseMap = new Map(phases.map(p => [p.phase_id, p]));

        if (!docs.length) {
            listEl.innerHTML = '<p class="hint">Belum ada dokumen yang disahkan Waka Kurikulum.</p>';
            return;
        }

        listEl.innerHTML = docs.map(doc => {
            const dtype    = DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type;
            const phase    = phaseMap.get(doc.phase_id);
            const semLabel = doc.semester ? ` · Semester ${doc.semester}` : '';
            const guruHtml = doc.teacher_name
                ? `<p style="margin:2px 0 0;font-size:12px;color:var(--color-text-muted)">Guru: ${esc(doc.teacher_name)}</p>`
                : '';
            return `
            <div style="border:1px solid var(--color-border);border-radius:var(--radius);padding:10px 12px;margin-bottom:8px">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap">
                    <div>
                        <p style="margin:0 0 2px;font-weight:600;font-size:13px">
                            <span style="color:var(--color-success,#16a34a)">✅</span>
                            ${esc(dtype)}${esc(semLabel)}
                        </p>
                        ${guruHtml}
                        <p style="margin:2px 0 0;font-size:12px;color:var(--color-text-muted)">
                            Disahkan: ${fmt(doc.updated_at)} · ${phase ? `Fase ${phase.code}` : ''} · ${doc.academic_year}
                        </p>
                    </div>
                </div>
            </div>`;
        }).join('');

    } catch (err) {
        listEl.innerHTML = `<div class="status-err">Gagal memuat. ${esc(fe(err))}</div>`;
    }
}

// ─── Modal: Profil Mengajar ───────────────────────────────────
function buildProfilMengajarHTML(p) {
    const v = p ?? {};
    const chk = (arr, val) => (arr ?? []).includes(val) ? 'checked' : '';
    const sel = (field, val) => v[field] === val ? 'checked' : '';
    return `
    <h2 style="margin:0 0 4px;font-size:18px">Profil Mengajar</h2>
    <p style="margin:0 0 20px;font-size:13px;color:var(--color-text-muted)">Diisi sekali, berlaku untuk semua mata pelajaran</p>

    <div class="pm-q"><p class="pm-label">1. Tujuan Utama Pembelajaran</p>
      ${[
        ['KONSEP_DASAR',         'Penguatan Konsep Dasar',              null],
        ['KEWIRAUSAHAAN',        'Projek Kewirausahaan',                null],
        ['UMKM',                 'UMKM Lokal',                          null],
        ['LITERASI',             'Penguatan Literasi',                   'Jenis literasi (membaca, menulis, dst)'],
        ['NUMERASI',             'Penguatan Numerasi',                   null],
        ['KOMUNIKASI',           'Komunikasi dan Interaksi',             'Konteks komunikasi (formal, informal, dunia kerja, dst)'],
        ['PENGEMBANGAN_KARAKTER','Pengembangan Karakter',               null],
        ['PERSIAPAN_AN',         'Persiapan Asesmen Nasional',          null],
        ['LAINNYA',              'Lainnya',                              'Jelaskan tujuan pembelajaran Anda'],
      ].map(([val, lbl, placeholder]) => {
        const isSelected = v.instructional_intent === val;
        const condDetail  = isSelected ? (v.intent_detail ?? '') : '';
        const condHtml    = placeholder ? `
          <div class="pm-cond-intent" id="pm-cond-${val}" style="display:${isSelected?'':'none'};margin:6px 0 4px 24px">
            <input type="text" class="input input-sm pm-cond-input" placeholder="${esc(placeholder)}" value="${esc(condDetail)}" style="width:100%;max-width:320px">
          </div>` : '';
        return `<label class="pm-radio-row"><input type="radio" name="instructional_intent" value="${val}" ${sel('instructional_intent',val)}> ${lbl}</label>${condHtml}`;
      }).join('')}
      <div style="margin-top:12px">
        <label style="font-size:13px;display:block;margin-bottom:4px;color:var(--color-text-muted)">Informasi tambahan <span style="font-weight:400">(opsional)</span></label>
        <textarea name="intent_detail" class="input" rows="3" placeholder="Tuliskan informasi tambahan tentang tujuan pembelajaran Anda..." style="width:100%;resize:vertical;font-size:13px">${esc(v.intent_detail ?? '')}</textarea>
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">2. Cara Penilaian Utama</p>
      ${[['PRAKTIK','Praktik'],['PORTOFOLIO','Portofolio'],['PRESENTASI','Presentasi'],
         ['OBSERVASI','Observasi'],['TES_TERTULIS','Tes Tertulis'],['KOMBINASI','Kombinasi']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="assessment_philosophy" value="${val}" ${sel('assessment_philosophy',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">3. Gaya Mengajar</p>
      ${[['GURU_DOMINAN','Guru dominan (saya memandu setiap langkah)'],
         ['SISWA_DOMINAN','Siswa dominan (saya sebagai fasilitator)'],
         ['SEIMBANG','Seimbang']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="teaching_style" value="${val}" ${sel('teaching_style',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">4. Model Pembelajaran</p>
      ${[['PBL_PROJECT','Project-Based Learning'],['PBL_PROBLEM','Problem-Based Learning'],
         ['DISCOVERY','Discovery Learning'],['CERAMAH_LATIHAN','Ceramah + Latihan']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="learning_model" value="${val}" ${sel('learning_model',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">5. Gaya Penyampaian</p>
      ${[['PRAKTIK','Banyak praktik'],['DISKUSI','Banyak diskusi'],['DEMONSTRASI','Banyak demonstrasi']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="delivery_style" value="${val}" ${sel('delivery_style',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">6. Pola Jadwal Mengajar</p>
      ${[['SPLIT_2JP','2 JP × beberapa hari terpisah'],['BLOCK_6JP','6 JP sekaligus (block)'],
         ['TEORI_PRAKTIK','Teori dulu lalu praktik'],['PRAKTIK_PENUH','Praktik penuh']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="schedule_pattern" value="${val}" ${sel('schedule_pattern',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">7. Durasi Proyek</p>
      ${[['1_MINGGU','1 minggu'],['2_4_MINGGU','2–4 minggu'],['SATU_SEMESTER','Satu semester']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="project_duration" value="${val}" ${sel('project_duration',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">8. Tingkat Kedalaman Materi</p>
      ${[['DASAR','Dasar'],['MENENGAH','Menengah'],['MAHIR','Mahir']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="depth_level" value="${val}" ${sel('depth_level',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">9. Konteks Lokal <span style="font-weight:400;color:var(--color-text-muted)">(opsional)</span></p>
      <div style="display:grid;gap:8px;max-width:360px">
        <label style="font-size:13px">Kota/daerah<input type="text" class="input input-sm" name="local_city" value="${esc(v.local_city??'')}" style="margin-top:4px"></label>
        <label style="font-size:13px">Industri lokal<input type="text" class="input input-sm" name="local_industry" value="${esc(v.local_industry??'')}" style="margin-top:4px"></label>
<label style="font-size:13px">Produk/jasa lokal<input type="text" class="input input-sm" name="local_products" value="${esc(v.local_products??'')}" style="margin-top:4px"></label>
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">10. Aktivitas yang Dihindari <span style="font-weight:400;color:var(--color-text-muted)">(opsional)</span></p>
      ${[['ROLE_PLAY','Role play'],['DEBAT','Debat'],['PRESENTASI_INDIVIDU','Presentasi individu'],
         ['TUGAS_RUMAH','Tugas rumah'],['OUTDOOR','Praktik outdoor']].map(val_lbl =>
        `<label class="pm-radio-row"><input type="checkbox" name="avoided_activities" value="${val_lbl[0]}" ${chk(v.avoided_activities, val_lbl[0])}> ${val_lbl[1]}</label>`
      ).join('')}
      <label class="pm-radio-row"><input type="checkbox" name="avoided_activities" value="LAINNYA" id="pm-avoided-lain-chk" ${chk(v.avoided_activities,'LAINNYA')}> Lainnya</label>
      <div id="pm-avoided-lain-detail" style="display:${(v.avoided_activities??[]).includes('LAINNYA')?'block':'none'};margin:4px 0 0 24px">
        <input type="text" class="input input-sm" name="avoided_detail" placeholder="Jelaskan" value="${esc(v.avoided_detail??'')}" style="max-width:280px">
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">11. Preferensi Integrasi <span style="font-weight:400;color:var(--color-text-muted)">(opsional)</span></p>
      ${[['NUMERASI','Numerasi'],['LITERASI','Literasi'],['AI_TEKNOLOGI','AI/Teknologi'],
         ['KEWIRAUSAHAAN','Kewirausahaan'],['BUDAYA_LOKAL','Budaya lokal'],
         ['PROFIL_LULUSAN','Profil Lulusan 8 Dimensi']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="checkbox" name="integration_prefs" value="${val}" ${chk(v.integration_prefs,val)}> ${lbl}</label>`
      ).join('')}
    </div>

    `;
}

function collectProfilMengajar(form) {
    const radio = name => form.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const checks = name => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
    const txt = name => form.querySelector(`input[name="${name}"]`)?.value.trim() || null;

    const intent = radio('instructional_intent');
    // Ambil dari input kondisional yang terlihat, fallback ke textarea intent_detail
    const visibleCond = form.querySelector(`.pm-cond-intent:not([style*="display:none"]):not([style*="display: none"]) .pm-cond-input`);
    const condVal = visibleCond?.value.trim() || null;
    const txtareaVal = form.querySelector('textarea[name="intent_detail"]')?.value.trim() || null;
    const intent_detail = condVal || txtareaVal || null;

    return {
        instructional_intent: intent,
        intent_detail,
        assessment_philosophy: radio('assessment_philosophy'),
        teaching_style: radio('teaching_style'),
        learning_model: radio('learning_model'),
        delivery_style: radio('delivery_style'),
        schedule_pattern: radio('schedule_pattern'),
        project_duration: radio('project_duration'),
        depth_level: radio('depth_level'),
        local_city: txt('local_city'),
        local_industry: txt('local_industry'),
local_products: txt('local_products'),
        avoided_activities: checks('avoided_activities'),
        avoided_detail: txt('avoided_detail'),
        integration_prefs: checks('integration_prefs'),
    };
}

async function openProfilMengajarModal() {
    let overlay = document.getElementById('profil-mengajar-modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'profil-mengajar-modal';
        overlay.className = 'modal-overlay';
        overlay.style.cssText = 'align-items:center';
        overlay.innerHTML = `
          <div class="sip-modal-panel" style="max-width:600px">
            <div class="sip-modal-scroll"><div id="pm-body"></div></div>
            <div class="sip-modal-footer">
              <button class="btn btn-secondary" id="pm-batal-btn">Batal</button>
              <button class="btn btn-primary" id="pm-simpan-btn">💾 Simpan Profil</button>
            </div>
          </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    document.getElementById('pm-body').innerHTML = '<p class="hint">Memuat profil…</p>';

    let profile = null;
    try {
        profile = await getTeacherProfile(currentUser.school_id);
    } catch (e) { /* biarkan kosong */ }

    const body = document.getElementById('pm-body');
    body.innerHTML = buildProfilMengajarHTML(profile);

    // Kondisional: tujuan — sembunyikan semua lalu tampilkan yang sesuai
    body.querySelectorAll('input[name="instructional_intent"]').forEach(r => {
        r.addEventListener('change', () => {
            body.querySelectorAll('.pm-cond-intent').forEach(el => el.style.display = 'none');
            const active = body.querySelector(`#pm-cond-${r.value}`);
            if (active) active.style.display = '';
        });
    });
    // Kondisional: avoided lainnya
    body.querySelector('#pm-avoided-lain-chk').addEventListener('change', e => {
        body.querySelector('#pm-avoided-lain-detail').style.display = e.target.checked ? '' : 'none';
    });

    overlay.querySelector('#pm-batal-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
    overlay.querySelector('#pm-simpan-btn').addEventListener('click', async () => {
        const btn = overlay.querySelector('#pm-simpan-btn');
        btn.disabled = true; btn.textContent = '…';
        try {
            await saveTeacherProfile(currentUser.school_id, collectProfilMengajar(body));
            overlay.style.display = 'none';
        } catch (err) {
            alert(`Gagal menyimpan: ${fe(err)}`);
        } finally {
            btn.disabled = false; btn.textContent = '💾 Simpan Profil';
        }
    });
}

// ─── Modal: Konteks Kelas ─────────────────────────────────────
function buildKonteksKelasHTML(ctx, subjName, ay) {
    const v = ctx ?? {};
    const chk = (arr, val) => (arr ?? []).includes(val) ? 'checked' : '';
    const sel = (field, val) => v[field] === val ? 'checked' : '';
    return `
    <h2 style="margin:0 0 2px;font-size:18px">Konteks Kelas</h2>
    <p style="margin:0 0 2px;font-size:13px;color:var(--color-text-muted)">Mata pelajaran: <strong>${esc(subjName)}</strong></p>
    <p style="margin:0 0 20px;font-size:13px;color:var(--color-text-muted)">Tahun ajaran: <strong>${esc(ay)}</strong></p>

    <div class="pm-q"><p class="pm-label">1. Latar Belakang Siswa</p>
      ${[['PETANI','Anak petani'],['PEDAGANG','Pedagang'],['PENGRAJIN','Pengrajin'],['CAMPURAN','Campuran']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="student_background" value="${val}" ${sel('student_background',val)}> ${lbl}</label>`
      ).join('')}
      <div style="margin-top:8px;max-width:280px">
        <label style="font-size:13px">Bahasa sehari-hari <span style="color:var(--color-text-muted)">(opsional)</span>
          <input type="text" class="input input-sm" name="daily_language" value="${esc(v.daily_language??'')}" style="margin-top:4px">
        </label>
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">2. Akses Teknologi Siswa</p>
      ${[['SMARTPHONE','Smartphone saja'],['LAPTOP','Laptop/komputer tersedia'],['TANPA_INTERNET','Tidak ada internet']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="tech_access" value="${val}" ${sel('tech_access',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">3. Karakteristik Kelas</p>
      ${[['PASIF','Pasif'],['AKTIF_BERTANYA','Aktif bertanya'],['SULIT_KELOMPOK','Sulit bekerja kelompok'],
         ['DISIPLIN_TINGGI','Disiplin tinggi'],['CEPAT_BOSAN','Cepat bosan'],['SANGAT_HETEROGEN','Sangat heterogen']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="checkbox" name="class_characteristics" value="${val}" ${chk(v.class_characteristics,val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">4. Tingkat Kemandirian Siswa</p>
      ${[['SANGAT_MANDIRI','Sangat mandiri (bisa bekerja tanpa arahan terus)'],
         ['PERLU_ARAHAN','Perlu arahan (butuh panduan setiap tahap)'],
         ['SANGAT_BERGANTUNG','Sangat bergantung (perlu scaffolding penuh)']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="student_autonomy" value="${val}" ${sel('student_autonomy',val)}> ${lbl}</label>`
      ).join('')}
    </div>

    <div class="pm-q"><p class="pm-label">5. Kendala di Kelas</p>
      ${[['INTERNET_MATI','Internet sering mati'],['LAB_BERGANTIAN','Lab dipakai bergantian'],
         ['HP_DILARANG','HP tidak boleh dibawa'],['PRAKTIK_SEMINGGU_SEKALI','Praktik hanya seminggu sekali'],
         ['WAKTU_MAKS_2JP','Waktu praktik maksimal 2 JP']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="checkbox" name="learning_constraints" value="${val}" ${chk(v.learning_constraints,val)}> ${lbl}</label>`
      ).join('')}
      <label class="pm-radio-row"><input type="checkbox" name="learning_constraints" value="LAINNYA" id="kk-kendala-lain-chk" ${chk(v.learning_constraints,'LAINNYA')}> Lainnya</label>
      <div id="kk-kendala-lain-detail" style="display:${(v.learning_constraints??[]).includes('LAINNYA')?'block':'none'};margin:4px 0 0 24px">
        <input type="text" class="input input-sm" name="constraints_detail" placeholder="Jelaskan" value="${esc(v.constraints_detail??'')}" style="max-width:280px">
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">6. Sumber Belajar yang Tersedia</p>
      ${[['BUKU_PAKET','Buku paket resmi'],['MODUL_SEKOLAH','Modul sekolah'],
         ['INTERNET_STABIL','Internet stabil'],['VIDEO_PEMBELAJARAN','Video pembelajaran'],
         ['LABORATORIUM','Laboratorium'],['TEACHING_FACTORY','Teaching Factory']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="checkbox" name="resources_available" value="${val}" ${chk(v.resources_available,val)}> ${lbl}</label>`
      ).join('')}
      <label class="pm-radio-row"><input type="checkbox" name="resources_available" value="NARASUMBER" id="kk-narasumber-chk" ${chk(v.resources_available,'NARASUMBER')}> Narasumber industri</label>
      <div id="kk-narasumber-detail" style="display:${(v.resources_available??[]).includes('NARASUMBER')?'block':'none'};margin:4px 0 0 24px">
        <input type="text" class="input input-sm" name="narasumber_detail" placeholder="Detail" value="${esc(v.narasumber_detail??'')}" style="max-width:280px">
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">7. Output Nyata yang Diharapkan</p>
      ${[['LAPORAN','Laporan tertulis'],['PRESENTASI','Presentasi'],['PRODUK_FISIK','Produk fisik'],
         ['WEB_APLIKASI','Website/Aplikasi'],['VIDEO','Video'],
         ['KONFIGURASI','Konfigurasi jaringan/sistem'],['PROTOTYPE','Prototype'],
         ['POSTER','Poster'],['SIMULASI','Simulasi']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="radio" name="expected_output" value="${val}" ${sel('expected_output',val)}> ${lbl}</label>`
      ).join('')}
      <label class="pm-radio-row"><input type="radio" name="expected_output" value="LAINNYA" ${sel('expected_output','LAINNYA')}> Lainnya</label>
      <div id="kk-output-lain-detail" style="display:${v.expected_output==='LAINNYA'?'block':'none'};margin:4px 0 0 24px">
        <input type="text" class="input input-sm" name="output_detail" placeholder="Jelaskan" value="${esc(v.output_detail??'')}" style="max-width:280px">
      </div>
    </div>

    <div class="pm-q"><p class="pm-label">8. Media & Alat yang Tersedia</p>
      ${[['PROYEKTOR','Proyektor/TV'],['SPEAKER','Speaker'],
         ['LAPTOP_SISWA','Laptop/komputer siswa'],['TABLET','Tablet'],
         ['KARTU','Kartu/flashcard'],['INTERNET_STABIL','Akses internet stabil'],
         ['PAPAN_TULIS','Papan tulis']].map(([val,lbl]) =>
        `<label class="pm-radio-row"><input type="checkbox" name="media_available" value="${val}" ${chk(v.media_available,val)}> ${lbl}</label>`
      ).join('')}
      <label class="pm-radio-row"><input type="checkbox" name="media_available" value="LAINNYA" id="kk-media-lain-chk" ${chk(v.media_available,'LAINNYA')}> Lainnya</label>
      <div id="kk-media-lain-detail" style="display:${(v.media_available??[]).includes('LAINNYA')?'block':'none'};margin:4px 0 0 24px">
        <input type="text" class="input input-sm" name="media_detail" placeholder="Jelaskan" value="${esc(v.media_detail??'')}" style="max-width:280px">
      </div>
    </div>

    `;
}

function collectKonteksKelas(form, subjectId, ay) {
    const radio = name => form.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const checks = name => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
    const txt = name => form.querySelector(`input[name="${name}"]`)?.value.trim() || null;
    const output = radio('expected_output');
    return {
        subject_id: subjectId,
        academic_year: ay,
        class_id: null,
        student_background: radio('student_background'),
        tech_access: radio('tech_access'),
        daily_language: txt('daily_language'),
        class_characteristics: checks('class_characteristics'),
        student_autonomy: radio('student_autonomy'),
        learning_constraints: checks('learning_constraints'),
        constraints_detail: txt('constraints_detail'),
        resources_available: checks('resources_available'),
        narasumber_detail: txt('narasumber_detail'),
        expected_output: output,
        output_detail: output === 'LAINNYA' ? txt('output_detail') : null,
        media_available: checks('media_available'),
        media_detail: txt('media_detail'),
    };
}

async function openKonteksKelasModal() {
    const ay = config?.current_academic_year ?? getCurrentAcademicYear();

    // Ambil mapel dari teaching_assignments — join ke public.subjects untuk nama
    // teaching_contexts.subject_id FK ke public.subjects (bukan core.subjects)
    let mySubjects = [];
    try {
        const { data: assignments, error } = await supabase
            .from('teaching_assignments')
            .select('subject_id, subject:subjects(subject_id, name, code)')
            .eq('school_id', currentUser.school_id)
            .eq('user_id', currentUser.user_id)
            .eq('academic_year', ay)
            .eq('is_active', true);
        if (!error && assignments?.length) {
            const seen = new Set();
            for (const a of assignments) {
                const s = a.subject;
                if (s && !seen.has(s.subject_id)) {
                    seen.add(s.subject_id);
                    mySubjects.push({ subject_id: s.subject_id, name: s.name, code: s.code });
                }
            }
            mySubjects.sort((a, b) => a.name.localeCompare(b.name, 'id'));
        }
    } catch (e) { /* */ }

    if (!mySubjects.length) {
        alert('Belum ada mata pelajaran yang diajar. Hubungi administrator untuk mengatur jadwal mengajar.');
        return;
    }

    let overlay = document.getElementById('konteks-kelas-modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'konteks-kelas-modal';
        overlay.className = 'modal-overlay';
        overlay.style.cssText = 'align-items:center';
        overlay.innerHTML = `
          <div class="sip-modal-panel" style="max-width:600px">
            <div class="sip-modal-scroll"><div id="kk-body"></div></div>
            <div class="sip-modal-footer" id="kk-footer" style="display:none">
              <button class="btn btn-secondary" id="kk-batal-btn">Batal</button>
              <button class="btn btn-primary" id="kk-simpan-btn">💾 Simpan Konteks</button>
            </div>
          </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.body.appendChild(overlay);
    }

    const openForSubject = async (subj) => {
        overlay.style.display = 'flex';
        document.getElementById('kk-footer').style.display = 'none';
        document.getElementById('kk-body').innerHTML = '<p class="hint">Memuat konteks…</p>';
        let ctx = null;
        try { ctx = await getTeachingContext(currentUser.school_id, subj.subject_id, ay); } catch (e) { /* */ }

        const body = document.getElementById('kk-body');
        body.innerHTML = buildKonteksKelasHTML(ctx, subj.name, ay);

        // Kondisional: kendala lainnya
        body.querySelector('#kk-kendala-lain-chk').addEventListener('change', e => {
            body.querySelector('#kk-kendala-lain-detail').style.display = e.target.checked ? '' : 'none';
        });
        // Kondisional: narasumber
        body.querySelector('#kk-narasumber-chk').addEventListener('change', e => {
            body.querySelector('#kk-narasumber-detail').style.display = e.target.checked ? '' : 'none';
        });
        // Kondisional: output lainnya
        body.querySelectorAll('input[name="expected_output"]').forEach(r => {
            r.addEventListener('change', () => {
                body.querySelector('#kk-output-lain-detail').style.display =
                    body.querySelector('input[name="expected_output"][value="LAINNYA"]:checked') ? '' : 'none';
            });
        });
        // Kondisional: media lainnya
        body.querySelector('#kk-media-lain-chk').addEventListener('change', e => {
            body.querySelector('#kk-media-lain-detail').style.display = e.target.checked ? '' : 'none';
        });

        // Tampilkan footer dan wire tombol
        const footer = document.getElementById('kk-footer');
        footer.style.display = '';
        const batalBtn  = overlay.querySelector('#kk-batal-btn');
        const simpanBtn = overlay.querySelector('#kk-simpan-btn');
        batalBtn.replaceWith(batalBtn.cloneNode(true));
        simpanBtn.replaceWith(simpanBtn.cloneNode(true));
        overlay.querySelector('#kk-batal-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
        overlay.querySelector('#kk-simpan-btn').addEventListener('click', async () => {
            const btn = overlay.querySelector('#kk-simpan-btn');
            btn.disabled = true; btn.textContent = '…';
            try {
                await saveTeachingContext(currentUser.school_id, collectKonteksKelas(body, subj.subject_id, ay));
                overlay.style.display = 'none';
            } catch (err) {
                alert(`Gagal menyimpan: ${fe(err)}`);
            } finally {
                btn.disabled = false; btn.textContent = '💾 Simpan Konteks';
            }
        });
    };

    if (mySubjects.length === 1) {
        await openForSubject(mySubjects[0]);
    } else {
        // Tampilkan dropdown pilih mapel
        overlay.style.display = 'flex';
        document.getElementById('kk-body').innerHTML = `
            <h2 style="margin:0 0 16px;font-size:18px">Pilih Mata Pelajaran</h2>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${mySubjects.map(s => `
                <button class="btn btn-secondary kk-subj-btn" data-subj-id="${esc(s.subject_id)}" style="text-align:left">${esc(s.name)}</button>
              `).join('')}
            </div>
            <div style="margin-top:16px;text-align:right">
              <button class="btn btn-secondary" id="kk-pick-batal">Batal</button>
            </div>`;
        document.getElementById('kk-pick-batal').addEventListener('click', () => { overlay.style.display = 'none'; });
        document.getElementById('kk-body').querySelectorAll('.kk-subj-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const subj = mySubjects.find(s => s.subject_id === btn.dataset.subjId);
                if (subj) await openForSubject(subj);
            });
        });
    }
}

// ─── Modal: Konfirmasi Generate ───────────────────────────────
const PROFIL_LABEL = {
    instructional_intent: { label: 'Tujuan', map: { KONSEP_DASAR:'Penguatan Konsep Dasar', KEWIRAUSAHAAN:'Projek Kewirausahaan', UMKM:'UMKM Lokal', LITERASI:'Penguatan Literasi', NUMERASI:'Penguatan Numerasi', KOMUNIKASI:'Komunikasi dan Interaksi', PENGEMBANGAN_KARAKTER:'Pengembangan Karakter', PERSIAPAN_AN:'Persiapan Asesmen Nasional', LAINNYA:'Lainnya' } },
    assessment_philosophy: { label: 'Cara penilaian', map: { PRAKTIK:'Praktik', PORTOFOLIO:'Portofolio', PRESENTASI:'Presentasi', OBSERVASI:'Observasi', TES_TERTULIS:'Tes Tertulis', KOMBINASI:'Kombinasi' } },
    teaching_style: { label: 'Gaya mengajar', map: { GURU_DOMINAN:'Guru dominan', SISWA_DOMINAN:'Siswa dominan', SEIMBANG:'Seimbang' } },
    learning_model: { label: 'Model', map: { PBL_PROJECT:'Project-Based Learning', PBL_PROBLEM:'Problem-Based Learning', DISCOVERY:'Discovery Learning', CERAMAH_LATIHAN:'Ceramah + Latihan' } },
};
const KONTEKS_LABEL = {
    student_autonomy: { label: 'Kemandirian siswa', map: { SANGAT_MANDIRI:'Sangat mandiri', PERLU_ARAHAN:'Perlu arahan', SANGAT_BERGANTUNG:'Sangat bergantung' } },
    expected_output: { label: 'Output nyata', map: { LAPORAN:'Laporan tertulis', PRESENTASI:'Presentasi', PRODUK_FISIK:'Produk fisik', WEB_APLIKASI:'Website/Aplikasi', VIDEO:'Video', KONFIGURASI:'Konfigurasi', PROTOTYPE:'Prototype', POSTER:'Poster', SIMULASI:'Simulasi', LAINNYA:'Lainnya' } },
};
const MEDIA_LABEL = { PROYEKTOR:'Proyektor/TV', SPEAKER:'Speaker', LAPTOP_SISWA:'Laptop siswa', TABLET:'Tablet', KARTU:'Kartu', INTERNET_STABIL:'Internet stabil', PAPAN_TULIS:'Papan tulis', LAINNYA:'Lainnya' };

async function openConfirmGenerateModal(coreSubjectId, phaseId, subjName, ay) {
    let overlay = document.getElementById('confirm-generate-modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'confirm-generate-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div style="background:var(--color-surface);border-radius:var(--radius-lg);padding:24px;width:100%;max-width:520px;margin:auto;position:relative"><div id="cg-body"></div></div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    document.getElementById('cg-body').innerHTML = '<p class="hint">Memuat…</p>';

    let profil = null, ctx = null;
    try { [profil, ctx] = await Promise.all([
        getTeacherProfile(currentUser.school_id),
        getTeachingContext(currentUser.school_id, coreSubjectId, ay),
    ]); } catch (e) { /* */ }

    const row = (label, val) => val
        ? `<div style="display:flex;gap:8px;font-size:13px;padding:3px 0"><span style="color:var(--color-success,#16a34a);flex-shrink:0">✓</span><span style="color:var(--color-text-muted);min-width:130px">${label}</span><span>${esc(val)}</span></div>`
        : '';

    let profilSection = '';
    if (profil) {
        const localCtx = [profil.local_city, profil.local_industry].filter(Boolean).join(' — ') || null;
        profilSection = `
        <div style="background:var(--color-bg-alt);border-radius:var(--radius);padding:12px;margin-bottom:12px">
          <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase">Profil Mengajar</p>
          ${Object.entries(PROFIL_LABEL).map(([k, {label, map}]) => row(label, map[profil[k]] ?? null)).join('')}
          ${localCtx ? row('Konteks lokal', localCtx) : ''}
          <button class="btn btn-secondary btn-sm" style="margin-top:10px;font-size:12px" id="cg-ubah-profil">⚙ Ubah Profil</button>
        </div>`;
    } else {
        profilSection = `
        <div style="background:var(--color-bg-alt);border-radius:var(--radius);padding:12px;margin-bottom:12px">
          <p style="margin:0 0 6px;font-size:13px">⚠️ Profil Mengajar belum diisi. AI akan menggunakan nilai default.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" id="cg-isi-profil">Isi Sekarang</button>
            <button class="btn btn-secondary btn-sm" id="cg-lanjut-tanpa-profil">Lanjutkan Tanpa Profil</button>
          </div>
        </div>`;
    }

    let ctxSection = '';
    if (ctx) {
        const mediaList = (ctx.media_available ?? []).map(m => MEDIA_LABEL[m] ?? m).join(', ') || null;
        ctxSection = `
        <div style="background:var(--color-bg-alt);border-radius:var(--radius);padding:12px;margin-bottom:12px">
          <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase">Konteks Kelas</p>
          ${Object.entries(KONTEKS_LABEL).map(([k, {label, map}]) => row(label, map[ctx[k]] ?? null)).join('')}
          ${mediaList ? row('Media tersedia', mediaList) : ''}
          <button class="btn btn-secondary btn-sm" style="margin-top:10px;font-size:12px" id="cg-ubah-konteks">⚙ Ubah Konteks</button>
        </div>`;
    }

    document.getElementById('cg-body').innerHTML = `
        <h2 style="margin:0 0 16px;font-size:18px">Konfirmasi Generate ATP</h2>
        <p style="margin:0 0 12px;font-size:13px;color:var(--color-text-muted)">Mapel: <strong>${esc(subjName)}</strong> · ${esc(ay)}</p>
        ${profilSection}
        ${ctxSection}
        <div style="margin-bottom:12px;padding:12px;background:var(--color-bg-alt);border-radius:var(--radius)">
          <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:var(--color-text-muted);text-transform:uppercase">Parameter JP</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">JP/minggu
              <input type="number" id="cg-jp-per-week" value="2" min="1" max="10"
                style="width:70px;padding:4px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:14px;background:var(--color-surface)">
            </label>
            <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">Minggu efektif
              <input type="number" id="cg-weeks-effective" value="18" min="1" max="26"
                style="width:70px;padding:4px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:14px;background:var(--color-surface)">
            </label>
            <label style="font-size:13px;display:flex;flex-direction:column;gap:4px">Semester
              <select id="cg-semester"
                style="width:90px;padding:4px 8px;border:1px solid var(--color-border);border-radius:4px;font-size:14px;background:var(--color-surface)">
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
          </div>
          <p style="margin:8px 0 0;font-size:12px;color:var(--color-text-muted)">Total JP: <span id="cg-total-jp-preview">36</span> JP</p>
        </div>
        <div id="cg-generate-msg" style="display:none;font-size:13px;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:16px;border-top:1px solid var(--color-border)">
          <button class="btn btn-secondary" id="cg-batal-btn">Batal</button>
          <button class="btn btn-primary" id="cg-generate-btn">✨ Generate</button>
        </div>`;

    const body = document.getElementById('cg-body');
    body.querySelector('#cg-batal-btn').addEventListener('click', () => { overlay.style.display = 'none'; });
    body.querySelector('#cg-ubah-profil')?.addEventListener('click', () => { overlay.style.display = 'none'; openProfilMengajarModal(); });
    body.querySelector('#cg-ubah-konteks')?.addEventListener('click', () => { overlay.style.display = 'none'; openKonteksKelasModal(); });
    body.querySelector('#cg-isi-profil')?.addEventListener('click', () => { overlay.style.display = 'none'; openProfilMengajarModal(); });
    body.querySelector('#cg-lanjut-tanpa-profil')?.addEventListener('click', () => {
        body.querySelector('#cg-generate-btn')?.removeAttribute('disabled');
    });

    // Update total JP preview saat input berubah
    const updateTotalJP = () => {
        const jp = parseInt(document.getElementById('cg-jp-per-week')?.value ?? '2', 10) || 0;
        const wk = parseInt(document.getElementById('cg-weeks-effective')?.value ?? '18', 10) || 0;
        const el = document.getElementById('cg-total-jp-preview');
        if (el) el.textContent = String(jp * wk);
    };
    body.querySelector('#cg-jp-per-week')?.addEventListener('input', updateTotalJP);
    body.querySelector('#cg-weeks-effective')?.addEventListener('input', updateTotalJP);

    body.querySelector('#cg-generate-btn')?.addEventListener('click', async () => {
        const btn   = body.querySelector('#cg-generate-btn');
        const msgEl = document.getElementById('cg-generate-msg');
        const jpPerWeek      = parseInt(document.getElementById('cg-jp-per-week')?.value ?? '2', 10);
        const weeksEffective = parseInt(document.getElementById('cg-weeks-effective')?.value ?? '18', 10);
        const semester       = parseInt(document.getElementById('cg-semester')?.value ?? '1', 10);

        btn.disabled    = true;
        btn.textContent = '⏳ Generating…';
        msgEl.style.display = 'none';

        try {
            overlay.style.display = 'none';
            await generateATP({
                coreSubjectId,
                phaseId,
                subjectName: subjName,
                academicYear: ay,
                semester,
                jpPerWeek,
                weeksEffective,
            });
        } catch (e) {
            overlay.style.display = 'flex';
            msgEl.textContent   = `✗ ${e.message ?? 'Gagal menghubungi AI'}`;
            msgEl.style.color   = 'var(--color-danger)';
            msgEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = '✨ Generate';
        }
    });
}

async function generateATP({ coreSubjectId, phaseId, subjectName, academicYear, semester, jpPerWeek, weeksEffective }) {
    // Tampilkan loading overlay
    let loadingEl = document.getElementById('atp-loading-overlay');
    if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.id = 'atp-loading-overlay';
        loadingEl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
        loadingEl.innerHTML = `<div style="background:var(--color-surface);border-radius:12px;padding:32px 40px;text-align:center;max-width:320px">
            <div style="font-size:32px;margin-bottom:12px">✨</div>
            <p style="margin:0 0 6px;font-weight:600">Gemini sedang menyusun ATP…</p>
            <p style="margin:0;font-size:13px;color:var(--color-text-muted)">Mohon tunggu, proses ini memerlukan 10–30 detik</p>
        </div>`;
        document.body.appendChild(loadingEl);
    }
    loadingEl.style.display = 'flex';

    try {
        const { data, error } = await supabase.functions.invoke('generate-atp-v2', {
            body: {
                school_id:       currentUser.school_id,
                subject_id:      coreSubjectId,
                core_subject_id: coreSubjectId,
                phase_id:        phaseId,
                academic_year:   academicYear,
                semester,
                jp_per_week:     jpPerWeek,
                weeks_effective: weeksEffective,
            },
        });

        loadingEl.style.display = 'none';

        if (error) throw new Error(error.message ?? 'Edge Function error');

        const result = data?.data ?? data;
        if (!result?.tujuan_pembelajaran?.length) throw new Error('Respons AI kosong atau format tidak valid');

        openATPReviewModal(result, data?.metadata ?? {}, {
            coreSubjectId, phaseId, subjectName, academicYear, semester,
        });
    } catch (e) {
        loadingEl.style.display = 'none';
        throw e;
    }
}

function openATPReviewModal(result, metadata, params) {
    let overlay = document.getElementById('atp-review-modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'atp-review-modal';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div style="background:var(--color-surface);border-radius:var(--radius-lg);padding:24px;width:100%;max-width:760px;margin:auto;position:relative;max-height:90vh;display:flex;flex-direction:column">
            <h2 style="margin:0 0 4px;font-size:18px">Hasil Generate ATP</h2>
            <p id="atp-review-meta" style="margin:0 0 16px;font-size:12px;color:var(--color-text-muted)"></p>
            <div id="atp-review-body" style="overflow-y:auto;flex:1"></div>
            <div id="atp-review-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:16px;border-top:1px solid var(--color-border);flex-shrink:0"></div>
        </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.body.appendChild(overlay);
    }

    const tps   = result.tujuan_pembelajaran ?? [];
    const total = result.total_jp ?? 0;
    const catatan = result.catatan ?? '';

    document.getElementById('atp-review-meta').textContent =
        `${params.subjectName} · Semester ${params.semester} · Total ${total} JP · Model: ${metadata.model ?? 'gemini-2.0-flash'}`;

    document.getElementById('atp-review-body').innerHTML = `
        <div style="overflow-x:auto;margin-bottom:12px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                    <tr style="background:var(--color-bg-alt)">
                        <th style="padding:8px;text-align:left;border-bottom:2px solid var(--color-border);width:40px">No</th>
                        <th style="padding:8px;text-align:left;border-bottom:2px solid var(--color-border)">Deskripsi TP</th>
                        <th style="padding:8px;text-align:left;border-bottom:2px solid var(--color-border);width:140px">Elemen CP</th>
                        <th style="padding:8px;text-align:center;border-bottom:2px solid var(--color-border);width:50px">JP</th>
                        <th style="padding:8px;text-align:left;border-bottom:2px solid var(--color-border);width:160px">Materi Pokok</th>
                    </tr>
                </thead>
                <tbody>
                    ${tps.map(tp => `
                        <tr style="border-bottom:1px solid var(--color-border)">
                            <td style="padding:8px;vertical-align:top;color:var(--color-text-muted)">${esc(String(tp.nomor ?? ''))}</td>
                            <td style="padding:8px;vertical-align:top">${esc(tp.deskripsi ?? '')}</td>
                            <td style="padding:8px;vertical-align:top;color:var(--color-text-muted);font-size:12px">${esc(tp.elemen_cp ?? '')}</td>
                            <td style="padding:8px;vertical-align:top;text-align:center;font-weight:600">${esc(String(tp.jp ?? ''))}</td>
                            <td style="padding:8px;vertical-align:top;font-size:12px">${esc(tp.materi_pokok ?? '')}</td>
                        </tr>`).join('')}
                    <tr style="background:var(--color-bg-alt);font-weight:600">
                        <td colspan="3" style="padding:8px;text-align:right">Total JP</td>
                        <td style="padding:8px;text-align:center">${esc(String(total))}</td>
                        <td></td>
                    </tr>
                </tbody>
            </table>
        </div>
        ${catatan ? `<p style="font-size:12px;color:var(--color-text-muted);margin:0">📝 ${esc(catatan)}</p>` : ''}`;

    document.getElementById('atp-review-actions').innerHTML = `
        <button class="btn btn-secondary" id="atp-regen-btn">🔄 Generate Ulang</button>
        <button class="btn btn-primary" id="atp-save-btn">💾 Simpan sebagai Draft</button>`;

    document.getElementById('atp-regen-btn').addEventListener('click', () => {
        overlay.style.display = 'none';
        openConfirmGenerateModal(params.coreSubjectId, params.phaseId, params.subjectName, params.academicYear);
    });

    document.getElementById('atp-save-btn').addEventListener('click', async () => {
        const saveBtn = document.getElementById('atp-save-btn');
        saveBtn.disabled    = true;
        saveBtn.textContent = '💾 Menyimpan…';
        try {
            await createTeacherDocument({
                schoolId:      currentUser.school_id,
                academicYear:  params.academicYear,
                documentType:  'ATP',
                coreSubjectId: params.coreSubjectId,
                phaseId:       params.phaseId,
                programId:     null,
                scopeType:     'SEMUA_KELAS',
                semester:      params.semester,
                tpUrutan:      null,
                contentJson:   {
                    judul:               `ATP ${params.subjectName} Semester ${params.semester}`,
                    tujuan_pembelajaran: result.tujuan_pembelajaran,
                    total_jp:            result.total_jp,
                    catatan:             result.catatan ?? '',
                    model_version:       metadata.model ?? 'gemini-2.0-flash',
                    generated_at:        metadata.generated_at ?? new Date().toISOString(),
                },
            });
            saveBtn.textContent = '✓ Tersimpan!';
            setTimeout(async () => {
                overlay.style.display = 'none';
                await loadPerangkatAjarDashboard();
            }, 900);
        } catch (e) {
            saveBtn.disabled    = false;
            saveBtn.textContent = '💾 Simpan sebagai Draft';
            alert(`Gagal menyimpan: ${e.message}`);
        }
    });

    overlay.style.display = 'flex';
}

// ─── Start ───────────────────────────────────────────────────
init().catch(err => {
    console.error('[init]', err);
    const el = document.getElementById('loading');
    if (el) {
        el.textContent = 'Gagal memuat. Silakan refresh halaman.';
        el.style.color = 'red';
    }
});
