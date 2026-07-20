/**
 * @file admin/js/wizard.js
 *
 * Controller untuk admin/wizard.html — wizard onboarding 10 langkah.
 * Step 1–2 (Profil & Tahun Ajaran) form manual; Step 3 (Program) form
 * manual + impor; Step 4–9 berbasis impor Excel/CSV (Kelas, Guru, Siswa,
 * Orang Tua, DUDI, Jadwal); Step 10 ringkasan + tombol "Buka Dashboard".
 *
 * State disimpan di memory saja (tidak localStorage) — refresh
 * memulai ulang wizard, tetapi data yang sudah tersimpan di DB
 * (school_config / academic_periods) akan di-pre-fill saat render.
 *
 * Semua akses Supabase lewat client yang diekspor api.js — tidak ada
 * createClient kedua di sini.
 */

import { checkMustChangePassword } from '../../shared/change-password.js';

import {
    supabase,
    getCurrentUserRow, requireAdministrativeOrRedirect,
    getSchoolConfig, upsertSchoolConfig, markSetupCompleted,
    getPrograms, getClasses, getTeacherList, deleteBulk, changePassword,
    fetchAllRows,
    updateProgram, updateClass, updateStudent, updateUserIdentifier,
    importPrograms, importClasses, importUsers, importStudents, importSchedules,
    importParents,
    getForumBkStaff, getForumGuruWaliCandidates,
    getBkAssignments, getGuruWaliAssignments,
    assignBkToClass, revokeBkFromClass,
    assignGuruWaliToStudent, revokeGuruWaliFromStudent,
    wizardResetStudents, wizardResetSchedules,
    deleteUserWithAuth,
    logout,
} from './api.js';

import { openScheduleBuilder } from './schedule-builder.js';

/** Escape HTML untuk mencegah XSS di innerHTML */
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const TOTAL_STEPS = 12;
const SKIPPED_STEPS = new Set([8]);

function nextValidStep(current) {
    let next = current + 1;
    while (SKIPPED_STEPS.has(next)) next++;
    return next;
}
function prevValidStep(current) {
    let prev = current - 1;
    while (SKIPPED_STEPS.has(prev)) prev--;
    return prev;
}

const STEP_NAMES = {
    1: 'Profil Sekolah',
    2: 'Tahun Ajaran',
    3: 'Program Keahlian',
    4: 'Kelas & Rombel',
    5: 'Staf & Peran',
    6: 'Siswa',
    7: 'Orang Tua',
    9: 'Stakeholder',
    10: 'Jadwal',
    11: 'Penugasan Forum',
    12: 'Selesai',
};

// ─────────────────────────────────────────────────────────────
// STATE (in-memory)
// ─────────────────────────────────────────────────────────────

const state = {
    currentStep:    1,
    completedSteps: new Set(),
    schoolId:       null,
    data: {
        schoolName:   '',
        address:      '',
        academicYear: '',
        semester:     '',   // '1' = Ganjil, '2' = Genap
        startDate:    '',
        endDate:      '',
    },
};

// ─────────────────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────────────────

const contentEl  = document.getElementById('wizard-step-content');
const errorEl     = document.getElementById('wizard-error');
const activeNameEl = document.getElementById('wizard-active-step-name');
const prevBtn     = document.getElementById('wizard-prev-btn');
const nextBtn     = document.getElementById('wizard-next-btn');

// ─────────────────────────────────────────────────────────────
// ERROR HELPERS
// ─────────────────────────────────────────────────────────────

function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
}

function clearError() {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
}

function showSuccess(msg) {
    errorEl.textContent = msg;
    errorEl.className = 'alert alert-success';
    errorEl.style.display = 'block';
    setTimeout(() => {
        errorEl.style.display = 'none';
        errorEl.className = 'alert alert-danger';
    }, 5000);
}

// ─────────────────────────────────────────────────────────────
// NAVIGATION / RENDER
// ─────────────────────────────────────────────────────────────

function markDone(n) {
    state.completedSteps.add(n);
    syncSidebar();
}

function syncSidebar() {
    document.querySelectorAll('#wizard-steps .wz-step-item').forEach(el => {
        const step = Number(el.dataset.step);
        const isActive = step === state.currentStep;
        const isDone   = state.completedSteps.has(step) && !isActive;

        el.classList.toggle('is-active', isActive);
        el.classList.toggle('is-done', isDone);

        // Marker: centang untuk langkah selesai, nomor untuk lainnya
        const marker = el.querySelector('.wz-marker');
        if (marker) marker.textContent = isDone ? '✓' : String(step);

        // Hanya langkah yang sudah selesai yang bisa diklik
        const canClick = state.completedSteps.has(step);
        el.style.cursor = canClick ? 'pointer' : 'default';
    });

    document.querySelectorAll('#wizard-progress-mobile .wz-bar').forEach(el => {
        const step = Number(el.dataset.step);
        el.classList.toggle('is-active', step === state.currentStep);
        el.classList.toggle('is-done', state.completedSteps.has(step) && step !== state.currentStep);
    });
}

function syncFooter() {
    prevBtn.disabled = state.currentStep === 1;
    nextBtn.textContent = state.currentStep === TOTAL_STEPS ? 'Buka Dashboard' : 'Selanjutnya';
}

async function goToStep(n) {
    if (n < 1 || n > TOTAL_STEPS) return;
    clearError();
    state.currentStep = n;
    history.replaceState(null, '', '#' + n);
    activeNameEl.textContent = STEP_NAMES[n];
    syncSidebar();
    syncFooter();

    const renderer = STEP_RENDERERS[n] ?? renderPlaceholder;
    contentEl.innerHTML = '<p class="hint">Memuat…</p>';
    try {
        await renderer();
    } catch (err) {
        contentEl.innerHTML = '';
        showError(err.message ?? 'Gagal memuat langkah ini.');
    }
}

// ─────────────────────────────────────────────────────────────
// STEP RENDERERS
// ─────────────────────────────────────────────────────────────

async function renderStep1() {
    // Pre-fill dari DB jika sudah ada (resume) — fallback ke state memory
    let config = null;
    try { config = await getSchoolConfig(); } catch { /* abaikan, form kosong */ }

    const name    = state.data.schoolName || config?.school_name || '';
    const address = state.data.address    || config?.address     || '';

    contentEl.innerHTML = `
        <div class="step-label">Langkah 1 dari ${TOTAL_STEPS}</div>
        <h3>Profil Sekolah</h3>
        <div class="field">
            <label for="wz-school-name">Nama Sekolah</label>
            <input type="text" id="wz-school-name" class="input"
                placeholder="contoh: SMK Negeri 1 Contoh" value="${escapeAttr(name)}" />
        </div>
        <div class="field">
            <label for="wz-address">Alamat</label>
            <textarea id="wz-address" class="input" rows="3"
                placeholder="Alamat lengkap sekolah">${escapeHtml(address)}</textarea>
        </div>
    `;
    nextBtn.disabled = false;
}

async function renderStep2() {
    let config = null;
    try { config = await getSchoolConfig(); } catch { /* abaikan */ }

    // Cek apakah sudah ada academic_periods (sekolah sudah beroperasi)
    let existingPeriods = [];
    if (config) {
        const { data } = await supabase
            .from('academic_periods')
            .select('academic_year, semester, start_date, end_date, status')
            .order('academic_year', { ascending: false })
            .order('semester',      { ascending: false })
            .limit(4);
        existingPeriods = data ?? [];
    }

    const isOperational = existingPeriods.length > 0;

    if (isOperational) {
        // Sekolah sudah beroperasi — tampil info saja, tidak bisa diedit.
        // Tahun ajaran hanya berubah melalui Tutup Semester → Tutup Tahun.
        const active = existingPeriods.find(p => p.status === 'ACTIVE') ?? existingPeriods[0];
        const semLabel = active.semester === '1' ? 'Ganjil' : 'Genap';
        const rows = existingPeriods.map(p => `
            <tr>
                <td>${p.academic_year}</td>
                <td>Semester ${p.semester} (${p.semester === '1' ? 'Ganjil' : 'Genap'})</td>
                <td>${p.start_date} – ${p.end_date}</td>
                <td><span class="badge ${p.status === 'ACTIVE' ? 'badge-success' : 'badge-muted'}">${p.status === 'ACTIVE' ? 'Aktif' : 'Ditutup'}</span></td>
            </tr>`).join('');

        contentEl.innerHTML = `
            <div class="step-label">Langkah 2 dari ${TOTAL_STEPS}</div>
            <h3>Tahun Ajaran</h3>
            <div class="alert alert-info" style="margin-bottom:20px">
                <strong>Periode akademik dikelola otomatis.</strong><br>
                Tahun ajaran berubah melalui <strong>Tutup Semester</strong> dan
                <strong>Tutup Tahun Ajaran</strong> di dashboard — bukan di sini.
            </div>
            <p class="hint">Periode yang tercatat untuk sekolah ini:</p>
            <table class="table">
                <thead><tr><th>Tahun Ajaran</th><th>Semester</th><th>Periode</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p style="margin-top:16px">
                Periode aktif saat ini: <strong>${active.academic_year} — Semester ${active.semester} (${semLabel})</strong>
            </p>
        `;

        // Simpan ke state agar saveStep2 tetap bisa jalan tanpa error
        state.data.academicYear = active.academic_year;
        state.data.semester     = active.semester;
        state.data.startDate    = active.start_date;
        state.data.endDate      = active.end_date;
        nextBtn.disabled = false;
        return;
    }

    // Belum ada periode — setup pertama kali, tampil form
    const academicYear = state.data.academicYear || config?.current_academic_year || '';
    const semester     = state.data.semester     || config?.current_semester      || '1';

    const thisYear = new Date().getFullYear();
    const yearOptions = [];
    for (let y = thisYear - 1; y <= thisYear + 2; y++) {
        const val = `${y}/${y + 1}`;
        yearOptions.push(`<option value="${val}" ${val === academicYear ? 'selected' : ''}>${val}</option>`);
    }

    function defaultDates(ay, sem) {
        if (!ay) return { start: '', end: '' };
        const [startY, endY] = ay.split('/').map(Number);
        if (sem === '1') return { start: `${startY}-07-01`, end: `${startY}-12-31` };
        return { start: `${endY}-01-01`, end: `${endY}-06-30` };
    }

    const def = defaultDates(academicYear, semester);
    const startDate = state.data.startDate || def.start;
    const endDate   = state.data.endDate   || def.end;

    contentEl.innerHTML = `
        <div class="step-label">Langkah 2 dari ${TOTAL_STEPS}</div>
        <h3>Tahun Ajaran</h3>
        <div class="field">
            <label for="wz-academic-year">Tahun Ajaran</label>
            <select id="wz-academic-year" class="input">${yearOptions.join('')}</select>
        </div>
        <div class="field">
            <label>Semester</label>
            <label style="font-weight:400; display:inline-flex; gap:6px; margin-right:18px;">
                <input type="radio" name="wz-semester" value="1" ${semester === '1' ? 'checked' : ''} /> Ganjil (Juli–Des)
            </label>
            <label style="font-weight:400; display:inline-flex; gap:6px;">
                <input type="radio" name="wz-semester" value="2" ${semester === '2' ? 'checked' : ''} /> Genap (Jan–Jun)
            </label>
        </div>
        <div class="field">
            <label for="wz-start-date">Tanggal Mulai</label>
            <input type="date" id="wz-start-date" class="input" value="${escapeAttr(startDate)}" />
        </div>
        <div class="field">
            <label for="wz-end-date">Tanggal Selesai</label>
            <input type="date" id="wz-end-date" class="input" value="${escapeAttr(endDate)}" />
        </div>
    `;

    function updateDates() {
        const ay  = document.getElementById('wz-academic-year').value;
        const sem = document.querySelector('input[name="wz-semester"]:checked')?.value || '1';
        const d   = defaultDates(ay, sem);
        document.getElementById('wz-start-date').value = d.start;
        document.getElementById('wz-end-date').value   = d.end;
        state.data.startDate = '';
        state.data.endDate   = '';
    }

    document.getElementById('wz-academic-year').addEventListener('change', updateDates);
    document.querySelectorAll('input[name="wz-semester"]').forEach(r =>
        r.addEventListener('change', updateDates)
    );

    nextBtn.disabled = false;
}

function renderPlaceholder() {
    const step = state.currentStep;
    contentEl.innerHTML = `
        <div class="step-label">Langkah ${step} dari ${TOTAL_STEPS}</div>
        <h3>${STEP_NAMES[step]}</h3>
        ${templateButtonHtml(step)}
        <p>Langkah ini akan segera tersedia.</p>
    `;
    wireTemplateButton(step);
    // Placeholder belum bisa dilanjutkan
    nextBtn.disabled = true;
}

async function renderSummaryStep() {
    const rows = [];
    for (let i = 1; i <= TOTAL_STEPS; i++) {
        const done = state.completedSteps.has(i);
        rows.push(`
            <tr>
                <td style="width:32px">${done ? '✔' : '○'}</td>
                <td>${STEP_NAMES[i]}</td>
                <td><span class="badge ${done ? 'badge-success' : 'badge-muted'}">${done ? 'Selesai' : 'Belum'}</span></td>
            </tr>
        `);
    }
    const incomplete = [];
    for (let i = 1; i < TOTAL_STEPS; i++) {
        if (!state.completedSteps.has(i)) incomplete.push(STEP_NAMES[i]);
    }
    const warningHtml = incomplete.length > 0
        ? `<div class="alert alert-warning">Langkah belum selesai: ${incomplete.join(', ')}. Anda tetap bisa melanjutkan, tapi sebaiknya selesaikan semua langkah agar platform berfungsi penuh.</div>`
        : '';

    contentEl.innerHTML = `
        <div class="step-label">Langkah ${TOTAL_STEPS} dari ${TOTAL_STEPS}</div>
        <h3>Selesai</h3>
        <p>Tinjau status setiap langkah sebelum membuka dashboard.</p>
        ${warningHtml}
        <table class="table"><tbody>${rows.join('')}</tbody></table>
        <p class="hint">Klik "Buka Dashboard" untuk menandai setup selesai dan masuk ke konsol admin.</p>
    `;
    nextBtn.disabled = false;
}

async function renderStep3() {
    const programs = await getPrograms();

    contentEl.innerHTML = `
        <div class="step-label">Langkah 3 dari ${TOTAL_STEPS}</div>
        <h3>Program Keahlian</h3>
        <p class="hint">Unduh template, isi data, lalu unggah. Panduan pengisian ada di sheet PETUNJUK dalam template.</p>
        ${templateButtonHtml(3)}
        <div id="wz-data-list"></div>

        <hr style="margin:24px 0;border:none;border-top:1px solid var(--color-border)" />
        <h4 style="margin:0 0 8px">Impor dari file</h4>
        ${importBlockHtml(3)}
    `;

    wireTemplateButton(3);
    wireImportBlock(3, { onDone: async () => { await refreshDataList(3); nextBtn.disabled = (await getPrograms()).length < 1; } });
    await refreshDataList(3);

    nextBtn.disabled = programs.length < 1;
}

async function renderStakeholderStep() {
    contentEl.innerHTML = `
        <div class="step-label">Langkah 9 dari ${TOTAL_STEPS}</div>
        <h3>Stakeholder</h3>
        <p class="hint">Tambahkan akun stakeholder (komite sekolah, dinas pendidikan, dll). Stakeholder hanya bisa melihat ringkasan data sekolah, tidak bisa mengubah apa pun. Login menggunakan kode khusus yang Anda tentukan.</p>

        <div id="wz-data-list"><p class="hint">Memuat data…</p></div>

        <hr style="margin:24px 0;border:none;border-top:1px solid var(--color-border)" />
        <h4 style="margin:0 0 12px">Tambah Stakeholder</h4>
        <div class="field">
            <label for="wz-sh-name">Nama</label>
            <input type="text" id="wz-sh-name" class="input" placeholder="contoh: Komite Sekolah" />
        </div>
        <div class="field">
            <label for="wz-sh-code">Kode Login</label>
            <input type="text" id="wz-sh-code" class="input" maxlength="50" placeholder="contoh: KOMITE01" />
            <p class="hint">Kode unik untuk login. Akan otomatis menjadi huruf besar.</p>
        </div>
        <button type="button" class="btn btn-primary" id="wz-sh-add">Tambah</button>
    `;

    const codeInput = document.getElementById('wz-sh-code');
    codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

    document.getElementById('wz-sh-add').addEventListener('click', async () => {
        clearError();
        const nameEl = document.getElementById('wz-sh-name');
        const codeEl = document.getElementById('wz-sh-code');
        const name = nameEl.value.trim();
        const code = codeEl.value.trim().toUpperCase();

        if (!name) { showError('Nama stakeholder wajib diisi.'); return; }
        if (!code) { showError('Kode login wajib diisi.'); return; }

        const addBtn = document.getElementById('wz-sh-add');
        addBtn.disabled = true;
        addBtn.textContent = 'Menyimpan…';
        try {
            const csv = `nama,nip_atau_nik,role_type\n${name},${code},STAKEHOLDER`;
            const result = await importUsers(csv);
            const savedCode = code;
            // Password acak terpisah dari kode — ambil dari response edge function
            const tempPassword = result?.imported?.[0]?.temp_password ?? '(lihat di konsol admin)';
            nameEl.value = '';
            codeEl.value = '';
            await refreshDataList(9);
            showSuccess(`Stakeholder "${name}" berhasil ditambahkan.\nKode login: ${savedCode}\nPassword awal: ${tempPassword}\n\nCatat dan bagikan keduanya kepada stakeholder. Password tidak bisa ditampilkan ulang.`);
        } catch (err) {
            console.error('[wizard] tambah stakeholder error:', err);
            const listEl = document.getElementById('wz-data-list');
            if (listEl) {
                const errDiv = document.createElement('div');
                errDiv.className = 'alert alert-danger';
                errDiv.textContent = err.message ?? 'Gagal menambah stakeholder.';
                listEl.prepend(errDiv);
            }
            showError(err.message ?? 'Gagal menambah stakeholder.');
        } finally {
            addBtn.disabled = false;
            addBtn.textContent = 'Tambah';
        }
    });

    await refreshDataList(9);
    nextBtn.disabled = false;
}

// ── Langkah 11: Penugasan Forum ───────────────────────────────

let _wzFkTab            = 'bk';
let _wzFkClasses        = [];
let _wzFkBkStaff        = [];
let _wzFkGuruWaliCands  = [];
let _wzFkBkAssignments  = [];
let _wzFkGwAssignments  = [];
let _wzFkAcademicYear   = null;
let _wzFkCurrentUserId  = null;

// ── Import BK & Guru Wali ─────────────────────────────────

/**
 * Import penugasan BK ke kelas dari CSV.
 * Format kolom: nama_kelas, kode_program, nip_bk
 * Return: { success, skipped, errors: [{row, reason}] }
 */
async function importForumBk(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idxKelas   = headers.indexOf('nama_kelas');
    const idxProgram = headers.indexOf('kode_program');
    const idxNip     = headers.indexOf('nip_bk');

    if (idxKelas < 0 || idxProgram < 0 || idxNip < 0) {
        throw new Error(
            'Header CSV tidak sesuai. Kolom wajib: nama_kelas, kode_program, nip_bk'
        );
    }

    const config = await getSchoolConfig();
    const academicYear = config.current_academic_year;

    // Fetch semua kelas dan staf BK sekali saja
    const [classes, programs, bkStaff, currentUserRow] = await Promise.all([
        getClasses(academicYear),
        getPrograms(),
        getForumBkStaff(),
        getCurrentUserRow(),
    ]);

    const programByCode = new Map(
        programs.map(p => [p.code.toLowerCase(), p])
    );
    const classByNameProgram = new Map(
        classes.map(c => [`${c.name.toLowerCase()}::${c.program_id}`, c])
    );
    const bkByNip = new Map(
        bkStaff.map(s => [s.login_identifier ?? '', s])
    );

    // Fetch login_identifier untuk BK (tidak ada di v_users_staff_directory)
    const { data: bkUsers } = await supabase
        .from('users')
        .select('user_id, login_identifier')
        .eq('role_type', 'BK')
        .eq('is_active', true);
    const bkNipToUserId = new Map(
        (bkUsers ?? []).map(u => [u.login_identifier, u.user_id])
    );

    let success = 0, skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.trim());
        const namaKelas  = cols[idxKelas]   ?? '';
        const kodeProgram = cols[idxProgram] ?? '';
        const nipBk      = cols[idxNip]     ?? '';

        if (!namaKelas || !kodeProgram || !nipBk) {
            errors.push({ row: i + 1, reason: 'Baris tidak lengkap' });
            continue;
        }

        const prog = programByCode.get(kodeProgram.toLowerCase());
        if (!prog) {
            errors.push({ row: i + 1, reason: `Program "${kodeProgram}" tidak ditemukan` });
            continue;
        }

        const cls = classByNameProgram.get(
            `${namaKelas.toLowerCase()}::${prog.program_id}`
        );
        if (!cls) {
            errors.push({ row: i + 1, reason: `Kelas "${namaKelas}" tidak ditemukan di program "${kodeProgram}"` });
            continue;
        }

        const bkUserId = bkNipToUserId.get(nipBk);
        if (!bkUserId) {
            errors.push({ row: i + 1, reason: `BK dengan NIP "${nipBk}" tidak ditemukan` });
            continue;
        }

        try {
            const result = await assignBkToClass(
                cls.class_id, bkUserId, academicYear,
                currentUserRow?.user_id ?? null
            );
            if (result === 'exists') skipped++;
            else success++;
        } catch (err) {
            errors.push({ row: i + 1, reason: err.message ?? 'Gagal menyimpan' });
        }
    }

    return { success, skipped, errors };
}

/**
 * Import penugasan Guru Wali ke siswa dari CSV.
 * Format kolom: nis_siswa, nip_guru_wali
 * Return: { success, skipped, errors: [{row, reason}] }
 */
async function importForumGuruWali(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idxNis  = headers.indexOf('nis_siswa');
    const idxNip  = headers.indexOf('nip_guru_wali');

    if (idxNis < 0 || idxNip < 0) {
        throw new Error(
            'Header CSV tidak sesuai. Kolom wajib: nis_siswa, nip_guru_wali'
        );
    }

    const config = await getSchoolConfig();
    const academicYear = config.current_academic_year;
    const currentUserRow = await getCurrentUserRow();

    // Fetch semua siswa aktif dan staf internal sekali saja
    const [{ data: students }, { data: gwStaff }] = await Promise.all([
        supabase
            .from('students')
            .select('student_id, nis')
            .eq('student_status', 'AKTIF'),
        supabase
            .from('users')
            .select('user_id, login_identifier')
            .in('role_type', [
                'GURU','BK','WALI_KELAS','KEPSEK',
                'WAKA_KURIKULUM','WAKA_KESISWAAN',
            ])
            .eq('is_active', true),
    ]);

    const studentByNis = new Map(
        (students ?? []).map(s => [s.nis, s.student_id])
    );
    const gwByNip = new Map(
        (gwStaff ?? []).map(u => [u.login_identifier, u.user_id])
    );

    let success = 0, skipped = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = line.split(',').map(c => c.trim());
        const nisSiswa   = cols[idxNis] ?? '';
        const nipGuru    = cols[idxNip] ?? '';

        if (!nisSiswa || !nipGuru) {
            errors.push({ row: i + 1, reason: 'Baris tidak lengkap' });
            continue;
        }

        const studentId = studentByNis.get(nisSiswa);
        if (!studentId) {
            errors.push({ row: i + 1, reason: `Siswa dengan NIS "${nisSiswa}" tidak ditemukan` });
            continue;
        }

        const guruUserId = gwByNip.get(nipGuru);
        if (!guruUserId) {
            errors.push({ row: i + 1, reason: `Guru dengan NIP "${nipGuru}" tidak ditemukan` });
            continue;
        }

        try {
            const result = await assignGuruWaliToStudent(
                studentId, guruUserId, academicYear,
                currentUserRow?.user_id ?? null
            );
            if (result === 'exists') skipped++;
            else success++;
        } catch (err) {
            errors.push({ row: i + 1, reason: err.message ?? 'Gagal menyimpan' });
        }
    }

    return { success, skipped, errors };
}

async function renderForumAssignmentStep() {
    contentEl.innerHTML = '<p class="hint">Memuat data penugasan…</p>';
    try {
        const config = await getSchoolConfig();
        _wzFkAcademicYear = config?.current_academic_year ?? null;

        const userRow = await getCurrentUserRow();
        _wzFkCurrentUserId = userRow?.user_id ?? null;

        const [classes, bkStaff, gwCands, bkAsgn, gwAsgn] =
            await Promise.all([
                getClasses(_wzFkAcademicYear),
                getForumBkStaff(),
                getForumGuruWaliCandidates(),
                getBkAssignments(_wzFkAcademicYear),
                getGuruWaliAssignments(_wzFkAcademicYear),
            ]);

        _wzFkClasses       = classes;
        _wzFkBkStaff       = bkStaff;
        _wzFkGuruWaliCands = gwCands;
        _wzFkBkAssignments = bkAsgn;
        _wzFkGwAssignments = gwAsgn;

        _wzFkTab = _wzFkTab ?? 'bk';
        contentEl.innerHTML = `
            <div class="step-label">Langkah 11 dari ${TOTAL_STEPS}</div>
            <h3>Penugasan Forum Kelas</h3>
            <p class="hint">Tugaskan BK ke kelas dan Guru Wali ke siswa via
                file Excel/CSV, atau isi manual di tab di bawah.</p>
            <div style="display:flex;gap:8px;margin-bottom:16px">
                <button id="wz-fk-tab-bk"
                    class="btn ${_wzFkTab === 'bk' ? 'btn-primary' : 'btn-secondary'}"
                    style="min-width:130px">BK per Kelas</button>
                <button id="wz-fk-tab-gw"
                    class="btn ${_wzFkTab === 'guru-wali' ? 'btn-primary' : 'btn-secondary'}"
                    style="min-width:130px">Guru Wali per Siswa</button>
            </div>
            <div id="wz-forum-tab-content"></div>
        `;

        document.getElementById('wz-fk-tab-bk').addEventListener('click', async () => {
            _wzFkTab = 'bk';
            document.getElementById('wz-fk-tab-bk').classList.replace('btn-secondary', 'btn-primary');
            document.getElementById('wz-fk-tab-gw').classList.replace('btn-primary', 'btn-secondary');
            await renderWzFkBkTab();
        });
        document.getElementById('wz-fk-tab-gw').addEventListener('click', async () => {
            _wzFkTab = 'guru-wali';
            document.getElementById('wz-fk-tab-gw').classList.replace('btn-secondary', 'btn-primary');
            document.getElementById('wz-fk-tab-bk').classList.replace('btn-primary', 'btn-secondary');
            await renderWzFkGuruWaliTab();
        });
        if (_wzFkTab === 'bk') await renderWzFkBkTab();
        else await renderWzFkGuruWaliTab();

    } catch (err) {
        contentEl.innerHTML =
            `<div class="step-label">Langkah 11 dari ${TOTAL_STEPS}</div>
             <h3>Penugasan Forum Kelas</h3>
             <div class="alert alert-danger">${esc(err?.message ?? String(err))}</div>`;
    }
    nextBtn.disabled = false;
}

/** Render hasil import Forum (BK atau Guru Wali) ke dalam elemen hasil. */
function renderForumImportResult({ success = 0, skipped = 0, errors = [] }) {
    let html = '';
    if (success > 0) {
        html += `<div class="alert alert-success">${success} penugasan berhasil ditambahkan.</div>`;
    }
    if (skipped > 0) {
        html += `<div class="alert alert-warning">${skipped} baris dilewati (sudah ada).</div>`;
    }
    if (errors.length > 0) {
        html += `<div class="alert alert-danger">
            ${errors.map(e => `Baris ${e.row}: ${escapeHtml(e.reason ?? '')}`).join('<br>')}
        </div>`;
    }
    if (!html) {
        html = `<div class="alert alert-warning">Tidak ada baris yang diproses.</div>`;
    }
    return html;
}

async function renderWzFkBkTab() {
    const tabEl = document.getElementById('wz-forum-tab-content');
    if (!_wzFkClasses.length) {
        tabEl.innerHTML = '<p class="hint">Belum ada kelas di tahun ajaran ini.</p>';
        return;
    }
    if (!_wzFkBkStaff.length) {
        tabEl.innerHTML = '<p class="hint">Belum ada staf dengan peran BK.</p>';
        return;
    }

    const programs = await getPrograms();
    const programNameById = new Map(programs.map(p => [p.program_id, p.name]));

    const programMap = new Map();
    _wzFkClasses.forEach(c => {
        const pid = c.program_id ?? '__no_program__';
        if (!programMap.has(pid)) programMap.set(pid, []);
        programMap.get(pid).push(c);
    });

    const asnMap = new Map();
    _wzFkBkAssignments.forEach(a => {
        if (!asnMap.has(a.class_id)) asnMap.set(a.class_id, []);
        asnMap.get(a.class_id).push(a);
    });

    const total = _wzFkBkAssignments.length;

    const sortedPids = [...programMap.keys()].sort((a, b) =>
        (programNameById.get(a) ?? 'Tanpa Program').localeCompare(
         programNameById.get(b) ?? 'Tanpa Program', 'id'));

    const accordions = sortedPids.map(pid => {
        const progName = programNameById.get(pid) ?? 'Tanpa Program';
        const classes = programMap.get(pid).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));

        const rows = classes.map(cls => {
            const assigned = asnMap.get(cls.class_id) ?? [];
            const chips = assigned.map(a => {
                const bk = _wzFkBkStaff.find(s => s.user_id === a.bk_user_id);
                if (!bk) return '';
                return esc(bk.full_name);
            }).filter(Boolean).join(', ');

            const aidList = assigned.map(a => a.assignment_id);
            const checkCell = `<td><input type="checkbox"
                class="wzfk-bk-check" ${aidList.length ? '' : 'disabled'}
                data-aids='${JSON.stringify(aidList)}'></td>`;

            return `<tr>
                ${checkCell}
                <td style="font-weight:500;word-break:break-word">${esc(cls.name)}</td>
                <td style="word-break:break-word">${chips}</td>
            </tr>`;
        }).join('');

        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">${esc(progName)} (${classes.length} kelas)</summary>
                <table class="table" style="width:100%;margin-top:4px;table-layout:fixed">
                    <thead><tr>
                        <th style="width:36px"></th>
                        <th style="width:35%">Kelas</th>
                        <th style="width:auto">BK yang Ditugaskan</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </details>`;
    }).join('');

    tabEl.innerHTML = `
        <button type="button" class="btn btn-secondary wz-template-btn" id="wz-fk-bk-tpl-btn"
            style="margin-bottom:16px">↓ Unduh Template BK</button>

        <h4 style="margin:0 0 8px">BK aktif (${total})</h4>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm btn-danger wzfk-bk-del-selected" disabled>Hapus Terpilih (0)</button>
            <button type="button" class="btn btn-sm btn-secondary wzfk-bk-del-all">Hapus Semua (${total})</button>
        </div>
        ${accordions}
        <p id="wz-fk-status" class="hint" style="margin-top:8px"></p>

        <hr style="margin:16px 0;border:none;border-top:1px solid var(--color-border)">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
            <input type="file" class="input" id="wz-fk-bk-file"
                accept=".xlsx,.xls,.csv" style="padding:6px" />
            <button type="button" class="btn btn-primary wz-import-btn" id="wz-fk-bk-import-btn"
                disabled>Impor BK</button>
        </div>
        <div id="wz-fk-bk-result"></div>
    `;

    // ── Unduh template BK ──
    tabEl.querySelector('#wz-fk-bk-tpl-btn').addEventListener('click', () => {
        const sheet = EXCEL_TEMPLATES[11]?.sheets?.bk;
        if (!sheet) return;
        generateExcelTemplate(
            'template_penugasan_bk.xlsx',
            sheet.headers, sheet.exampleRows, sheet.guide
        );
    });

    // ── Hapus terpilih / semua ──
    const selBtn  = tabEl.querySelector('.wzfk-bk-del-selected');
    const allBtn  = tabEl.querySelector('.wzfk-bk-del-all');
    const checks  = () => Array.from(tabEl.querySelectorAll('.wzfk-bk-check:not(:disabled)'));

    function syncSelBtn() {
        const n = checks().filter(c => c.checked).length;
        selBtn.textContent = `Hapus Terpilih (${n})`;
        selBtn.disabled = n === 0;
    }

    tabEl.querySelectorAll('.wzfk-bk-check').forEach(c => c.addEventListener('change', syncSelBtn));

    selBtn.addEventListener('click', async () => {
        const selected = checks().filter(c => c.checked);
        const aids = selected.flatMap(c => JSON.parse(c.dataset.aids));
        if (!aids.length) return;
        if (!confirm(`Hapus ${aids.length} penugasan BK terpilih?`)) return;
        selBtn.disabled = true;
        try {
            for (const aid of aids) await revokeBkFromClass(aid);
            _wzFkBkAssignments = await getBkAssignments(_wzFkAcademicYear);
            await renderWzFkBkTab();
        } catch (err) {
            const st = document.getElementById('wz-fk-status');
            if (st) st.textContent = 'Gagal menghapus: ' + (err?.message ?? String(err));
            selBtn.disabled = false;
        }
    });

    allBtn.addEventListener('click', async () => {
        if (!_wzFkBkAssignments.length) return;
        if (!confirm(`Hapus SEMUA ${_wzFkBkAssignments.length} penugasan BK?`)) return;
        allBtn.disabled = true;
        try {
            for (const a of _wzFkBkAssignments) await revokeBkFromClass(a.assignment_id);
            _wzFkBkAssignments = await getBkAssignments(_wzFkAcademicYear);
            await renderWzFkBkTab();
        } catch (err) {
            const st = document.getElementById('wz-fk-status');
            if (st) st.textContent = 'Gagal menghapus: ' + (err?.message ?? String(err));
            allBtn.disabled = false;
        }
    });

    // ── Import BK ──
    const bkFileInput = tabEl.querySelector('#wz-fk-bk-file');
    const bkImportBtn = tabEl.querySelector('#wz-fk-bk-import-btn');
    const bkResultEl  = tabEl.querySelector('#wz-fk-bk-result');
    let bkCsvText = null;

    bkFileInput.addEventListener('change', async () => {
        bkResultEl.innerHTML = '';
        const file = bkFileInput.files?.[0];
        if (!file) { bkCsvText = null; bkImportBtn.disabled = true; return; }
        try {
            bkCsvText = stripEmptyCsvLines(await fileToCsv(file));
            bkImportBtn.disabled = !bkCsvText.trim();
        } catch (err) {
            bkCsvText = null;
            bkImportBtn.disabled = true;
            bkResultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Gagal membaca file.')}</div>`;
        }
    });

    bkImportBtn.addEventListener('click', async () => {
        if (!bkCsvText) return;
        bkImportBtn.disabled = true;
        bkImportBtn.textContent = 'Mengimpor…';
        bkResultEl.innerHTML = '';
        try {
            const res = await importForumBk(bkCsvText);
            bkResultEl.innerHTML = renderForumImportResult(res);
            if (res.success > 0) {
                _wzFkBkAssignments = await getBkAssignments(_wzFkAcademicYear);
                await renderWzFkBkTab();
            } else {
                bkImportBtn.textContent = 'Impor BK';
                bkImportBtn.disabled = false;
            }
        } catch (err) {
            bkResultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Impor gagal.')}</div>`;
            bkImportBtn.textContent = 'Impor BK';
            bkImportBtn.disabled = false;
        }
    });
}

async function renderWzFkGuruWaliTab() {
    const tabEl = document.getElementById('wz-forum-tab-content');
    if (!_wzFkClasses.length) {
        tabEl.innerHTML = '<p class="hint">Belum ada kelas di tahun ajaran ini.</p>';
        return;
    }

    tabEl.innerHTML = '<p class="hint">Memuat siswa…</p>';

    let allEnrollments;
    try {
        const results = await Promise.all(_wzFkClasses.map(cls =>
            supabase
                .from('class_enrollments')
                .select('student:students(student_id, full_name, nis)')
                .eq('class_id',      cls.class_id)
                .eq('academic_year', _wzFkAcademicYear)
                .is('withdrawn_at',  null)
                .then(({ data, error }) => {
                    if (error) throw error;
                    return {
                        class_id: cls.class_id,
                        students: (data ?? [])
                            .map(r => r.student)
                            .filter(Boolean)
                            .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id')),
                    };
                })
        ));
        allEnrollments = new Map(results.map(r => [r.class_id, r.students]));
    } catch (err) {
        tabEl.innerHTML = `<div class="alert alert-danger">${esc(err?.message ?? String(err))}</div>`;
        return;
    }

    const programs = await getPrograms();
    const programNameById = new Map(programs.map(p => [p.program_id, p.name]));

    const programMap = new Map();
    _wzFkClasses.forEach(c => {
        const pid = c.program_id ?? '__no_program__';
        if (!programMap.has(pid)) programMap.set(pid, []);
        programMap.get(pid).push(c);
    });

    const asnMap = new Map();
    _wzFkGwAssignments.forEach(a => {
        if (!asnMap.has(a.student_id)) asnMap.set(a.student_id, []);
        asnMap.get(a.student_id).push(a);
    });

    const total = _wzFkGwAssignments.length;

    const sortedPids = [...programMap.keys()].sort((a, b) =>
        (programNameById.get(a) ?? 'Tanpa Program').localeCompare(
         programNameById.get(b) ?? 'Tanpa Program', 'id'));

    const accordions = sortedPids.map(pid => {
        const progName = programNameById.get(pid) ?? 'Tanpa Program';
        const classes  = programMap.get(pid).slice().sort((a, b) => a.name.localeCompare(b.name, 'id'));

        let progStudentTotal = 0;
        const classAccordions = classes.map(cls => {
            const students = allEnrollments.get(cls.class_id) ?? [];
            progStudentTotal += students.length;

            if (!students.length) {
                return `
                    <details class="wz-accordion wz-accordion-inner">
                        <summary class="wz-accordion-header">${esc(cls.name)} (0 siswa)</summary>
                        <p class="hint" style="margin:8px 16px">Tidak ada siswa aktif.</p>
                    </details>`;
            }

            const rows = students.map(stu => {
                const assigned = asnMap.get(stu.student_id) ?? [];
                const chips = assigned.map(a => {
                    const gw = _wzFkGuruWaliCands.find(s => s.user_id === a.guru_user_id);
                    if (!gw) return '';
                    return esc(gw.full_name);
                }).filter(Boolean).join(', ');

                const aidList   = assigned.map(a => a.assignment_id);
                const checkCell = `<td style="width:36px"><input type="checkbox"
                    class="wzfk-gw-check" ${aidList.length ? '' : 'disabled'}
                    data-aids='${JSON.stringify(aidList)}'></td>`;

                return `<tr>
                    ${checkCell}
                    <td>
                        <div style="font-weight:500">${esc(stu.full_name)}</div>
                        <div class="sub-label">${esc(stu.nis)}</div>
                    </td>
                    <td>${chips}</td>
                </tr>`;
            }).join('');

            return `
                <details class="wz-accordion wz-accordion-inner">
                    <summary class="wz-accordion-header">${esc(cls.name)} (${students.length} siswa)</summary>
                    <table class="table" style="width:100%;table-layout:fixed;margin-top:4px">
                        <thead><tr>
                            <th style="width:36px"></th>
                            <th style="width:55%">Siswa</th>
                            <th style="width:45%">Guru Wali</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </details>`;
        }).join('');

        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">${esc(progName)} (${progStudentTotal} siswa)</summary>
                <div style="padding:4px 0">${classAccordions}</div>
            </details>`;
    }).join('');

    tabEl.innerHTML = `
        <button type="button" class="btn btn-secondary wz-template-btn" id="wz-fk-gw-tpl-btn"
            style="margin-bottom:16px">↓ Unduh Template Guru Wali</button>

        <h4 style="margin:0 0 8px">Guru Wali aktif (${total})</h4>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <button type="button" class="btn btn-sm btn-danger wzfk-gw-del-selected" disabled>Hapus Terpilih (0)</button>
            <button type="button" class="btn btn-sm btn-secondary wzfk-gw-del-all">Hapus Semua (${total})</button>
        </div>
        ${accordions}
        <p id="wz-fk-gw-status" class="hint" style="margin-top:8px"></p>

        <hr style="margin:16px 0;border:none;border-top:1px solid var(--color-border)">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
            <input type="file" class="input" id="wz-fk-gw-file"
                accept=".xlsx,.xls,.csv" style="padding:6px" />
            <button type="button" class="btn btn-primary wz-import-btn" id="wz-fk-gw-import-btn"
                disabled>Impor Guru Wali</button>
        </div>
        <div id="wz-fk-gw-result"></div>
    `;

    // ── Unduh template Guru Wali (pre-filled siswa aktif) ──
    tabEl.querySelector('#wz-fk-gw-tpl-btn').addEventListener('click', async () => {
        const btn = tabEl.querySelector('#wz-fk-gw-tpl-btn');
        const gwResultEl = tabEl.querySelector('#wz-fk-gw-result');
        btn.disabled = true;
        btn.textContent = 'Memuat data siswa…';
        try {
            const [config, classes, programs] = await Promise.all([
                getSchoolConfig(),
                getClasses(_wzFkAcademicYear),
                getPrograms(),
            ]);
            const academicYear = _wzFkAcademicYear ?? config?.current_academic_year;
            const programByCode = new Map(programs.map(p => [p.program_id, p.code]));

            const rows = [];
            const sortedClasses = [...classes].sort((a, b) =>
                a.name.localeCompare(b.name, 'id'));

            for (const cls of sortedClasses) {
                const { data: enrollments } = await supabase
                    .from('class_enrollments')
                    .select('student:students(student_id, full_name, nis)')
                    .eq('class_id', cls.class_id)
                    .eq('academic_year', academicYear)
                    .is('withdrawn_at', null);

                const students = (enrollments ?? [])
                    .map(e => e.student)
                    .filter(Boolean)
                    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'));

                const kodeProgram = programByCode.get(cls.program_id) ?? '';
                for (const stu of students) {
                    rows.push([
                        cls.name,
                        kodeProgram,
                        stu.nis ?? '',
                        stu.full_name ?? '',
                        '', // nip_guru_wali — diisi admin
                    ]);
                }
            }

            if (typeof XLSX === 'undefined') {
                throw new Error('Pustaka Excel gagal dimuat. Periksa koneksi internet.');
            }

            const headers = ['nama_kelas', 'kode_program', 'nis_siswa', 'nama_siswa', 'nip_guru_wali'];
            const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

            ws['!cols'] = [
                { wch: 15 }, // nama_kelas
                { wch: 14 }, // kode_program
                { wch: 14 }, // nis_siswa
                { wch: 25 }, // nama_siswa
                { wch: 18 }, // nip_guru_wali
            ];

            const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
            for (let R = range.s.r; R <= range.e.r; R++) {
                for (let C = range.s.c; C <= range.e.c; C++) {
                    const addr = XLSX.utils.encode_cell({ r: R, c: C });
                    const cell = ws[addr] ?? { t: 's', v: '' };
                    cell.t = 's';
                    cell.z = '@';
                    ws[addr] = cell;
                }
            }

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Guru Wali');
            XLSX.writeFile(wb, 'template_guru_wali.xlsx');

        } catch (err) {
            gwResultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Gagal mengunduh template.')}</div>`;
        } finally {
            btn.disabled = false;
            btn.textContent = '↓ Unduh Template Guru Wali';
        }
    });

    // ── Hapus terpilih / semua ──
    const selBtn = tabEl.querySelector('.wzfk-gw-del-selected');
    const allBtn = tabEl.querySelector('.wzfk-gw-del-all');
    const checks = () => Array.from(tabEl.querySelectorAll('.wzfk-gw-check:not(:disabled)'));

    function syncSelBtn() {
        const n = checks().filter(c => c.checked).length;
        selBtn.textContent = `Hapus Terpilih (${n})`;
        selBtn.disabled = n === 0;
    }

    tabEl.querySelectorAll('.wzfk-gw-check').forEach(c => c.addEventListener('change', syncSelBtn));

    selBtn.addEventListener('click', async () => {
        const selected = checks().filter(c => c.checked);
        const aids = selected.flatMap(c => JSON.parse(c.dataset.aids));
        if (!aids.length) return;
        if (!confirm(`Hapus ${aids.length} penugasan Guru Wali terpilih?`)) return;
        selBtn.disabled = true;
        try {
            for (const aid of aids) await revokeGuruWaliFromStudent(aid);
            _wzFkGwAssignments = await getGuruWaliAssignments(_wzFkAcademicYear);
            await renderWzFkGuruWaliTab();
        } catch (err) {
            const st = document.getElementById('wz-fk-gw-status');
            if (st) st.textContent = 'Gagal menghapus: ' + (err?.message ?? String(err));
            selBtn.disabled = false;
        }
    });

    allBtn.addEventListener('click', async () => {
        if (!_wzFkGwAssignments.length) return;
        if (!confirm(`Hapus SEMUA ${_wzFkGwAssignments.length} penugasan Guru Wali?`)) return;
        allBtn.disabled = true;
        try {
            for (const a of _wzFkGwAssignments) await revokeGuruWaliFromStudent(a.assignment_id);
            _wzFkGwAssignments = await getGuruWaliAssignments(_wzFkAcademicYear);
            await renderWzFkGuruWaliTab();
        } catch (err) {
            const st = document.getElementById('wz-fk-gw-status');
            if (st) st.textContent = 'Gagal menghapus: ' + (err?.message ?? String(err));
            allBtn.disabled = false;
        }
    });

    // ── Import Guru Wali ──
    const gwFileInput = tabEl.querySelector('#wz-fk-gw-file');
    const gwImportBtn = tabEl.querySelector('#wz-fk-gw-import-btn');
    const gwResultEl  = tabEl.querySelector('#wz-fk-gw-result');
    let gwCsvText = null;

    gwFileInput.addEventListener('change', async () => {
        gwResultEl.innerHTML = '';
        const file = gwFileInput.files?.[0];
        if (!file) { gwCsvText = null; gwImportBtn.disabled = true; return; }
        try {
            gwCsvText = stripEmptyCsvLines(await fileToCsv(file));
            gwImportBtn.disabled = !gwCsvText.trim();
        } catch (err) {
            gwCsvText = null;
            gwImportBtn.disabled = true;
            gwResultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Gagal membaca file.')}</div>`;
        }
    });

    gwImportBtn.addEventListener('click', async () => {
        if (!gwCsvText) return;
        gwImportBtn.disabled = true;
        gwImportBtn.textContent = 'Mengimpor…';
        gwResultEl.innerHTML = '';
        try {
            const res = await importForumGuruWali(gwCsvText);
            gwResultEl.innerHTML = renderForumImportResult(res);
            if (res.success > 0) {
                _wzFkGwAssignments = await getGuruWaliAssignments(_wzFkAcademicYear);
                await renderWzFkGuruWaliTab();
            } else {
                gwImportBtn.textContent = 'Impor Guru Wali';
                gwImportBtn.disabled = false;
            }
        } catch (err) {
            gwResultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Impor gagal.')}</div>`;
            gwImportBtn.textContent = 'Impor Guru Wali';
            gwImportBtn.disabled = false;
        }
    });
}

async function renderScheduleStep() {
    contentEl.innerHTML = `
        <div class="step-label">Langkah 10 dari ${TOTAL_STEPS}</div>
        <h3>Jadwal</h3>
        <p class="hint">Susun jadwal mengajar secara visual, atau impor dari file CSV. Staf (langkah 5) dan kelas (langkah 4) harus sudah ada.</p>
        <p class="hint-success">✓ Langkah ini opsional — bisa dilewati dan disusun nanti setelah wizard selesai.</p>
        <button type="button" class="btn btn-primary" id="wz-open-schedule" style="margin-bottom:16px">Susun Jadwal Visual</button>

        <hr style="margin:16px 0;border-color:var(--color-border)">
        <h4 style="margin:0 0 6px">Impor dari file CSV / Excel</h4>
        <p class="hint" style="margin:0 0 8px">Kolom yang diharapkan: <code>kode_guru, nama_mapel, nama_kelas, hari, start_time, end_time</code><br>
        Hari: SENIN/SELASA/RABU/KAMIS/JUMAT/SABTU &nbsp;|&nbsp; Waktu: HH:MM (contoh: 07:00)<br>
        <em>kode_guru</em> = kode singkat guru dari daftar staf (contoh: BSS, ADF). <em>nama_mapel</em> = nama mata pelajaran.</p>
        <button type="button" class="btn btn-secondary wz-template-btn" id="wz-schedule-template-dl" style="margin-bottom:12px">⬇ Unduh Template Excel</button>
        <div class="field" style="margin-bottom:8px">
            <input type="file" id="wz-schedule-file" accept=".csv,.xlsx" class="input" style="padding:6px">
        </div>
        <button type="button" class="btn btn-primary wz-import-btn" id="wz-schedule-import">Unggah &amp; Impor</button>
        <div id="wz-schedule-import-status" style="margin-top:10px"></div>

        <div id="wz-data-list" style="margin-top:16px"><p class="hint">Memuat data…</p></div>
    `;

    document.getElementById('wz-open-schedule').addEventListener('click', () => openScheduleBuilder());

    document.getElementById('wz-schedule-template-dl').addEventListener('click', async () => {
        const btn = document.getElementById('wz-schedule-template-dl');
        btn.disabled = true;
        btn.textContent = 'Memuat data…';
        try {
            const [teachers, config] = await Promise.all([getTeacherList(), getSchoolConfig()]);
            const ay = config?.current_academic_year;
            const classes = ay ? await getClasses(ay) : await getClasses();
            const teachersWithCode = teachers.filter(t => t.teacher_code);
            const kelasNames = classes.map(c => c.name);

            // ── Slot waktu (format HH.MM - HH.MM sesuai format sekolah) ──
            // null = baris istirahat
            const SLOTS = [
                { no: 1,  w: '07.15 - 07.55' },
                { no: 2,  w: '07.55 - 08.35' },
                { no: 3,  w: '08.35 - 09.15' },
                { no: 4,  w: '09.15 - 09.55' },
                null, // ISTRAHAT 09.55 - 10.25
                { no: 5,  w: '10.25 - 11.05' },
                { no: 6,  w: '11.05 - 11.45' },
                { no: 7,  w: '11.45 - 12.25' },
                null, // ISTRAHAT 12.25 - 13.00
                { no: 8,  w: '13.00 - 13.40' },
                { no: 9,  w: '13.40 - 14.20' },
                { no: 10, w: '14.20 - 15.00' },
                { no: 11, w: '15.00 - 15.40' },
            ];
            const DAYS = ['SENIN','SELASA','RABU','KAMIS',"JUM'AT"];

            // ── Format identik dengan jadwal sekolah ─────────────────────
            // Row 0: '', HARI, NO, WAKTU, Kelas1, '', Kelas2, '', ...
            // Row 1: '', '', '', '', MAPEL, KG, MAPEL, KG, ...
            // Data: '', HARI(atau ''), no, 'HH.MM - HH.MM', mapel, kg, ...
            const row0 = ['', 'HARI', 'NO', 'WAKTU', ...kelasNames.flatMap(k => [k, ''])];
            const row1 = ['', '', '', '', ...kelasNames.flatMap(() => ['MAPEL', 'KG'])];
            const aoa  = [row0, row1];

            for (const hari of DAYS) {
                let firstSlot = true;
                let breakCount = 0;
                for (const slot of SLOTS) {
                    if (slot === null) {
                        const labels = ['09.55 - 10.25', '12.25 - 13.00'];
                        aoa.push(['', '', '', `ISTRAHAT ${labels[breakCount++] ?? ''}`, ...kelasNames.flatMap(() => ['', ''])]);
                        continue;
                    }
                    aoa.push(['', firstSlot ? hari : '', slot.no, slot.w, ...kelasNames.flatMap(() => ['', ''])]);
                    firstSlot = false;
                }
            }

            // ── Sheet 1: Template Jadwal ──────────────────────────────────
            const ws1 = XLSX.utils.aoa_to_sheet(aoa);

            // Merge sel nama kelas di row 0 (2 kolom per kelas)
            ws1['!merges'] = kelasNames.map((_, i) => ({
                s: { r: 0, c: 4 + i * 2 },
                e: { r: 0, c: 5 + i * 2 },
            }));

            // Lebar kolom: blank | HARI | NO | WAKTU | (MAPEL | KG) × n
            ws1['!cols'] = [
                { wch: 2  }, // kolom A kosong
                { wch: 10 }, // HARI
                { wch: 4  }, // NO
                { wch: 16 }, // WAKTU
                ...kelasNames.flatMap(() => [{ wch: 12 }, { wch: 8 }]),
            ];

            // ── Sheet 2: Daftar Guru (referensi KG) ─────────────────────
            const guruRows = [['kode_guru', 'nama_guru']];
            for (const t of teachersWithCode) guruRows.push([t.teacher_code, t.full_name]);
            if (guruRows.length === 1) guruRows.push(['(belum ada guru)', '(import guru dulu di langkah 5)']);

            // ── Sheet 3: Petunjuk ────────────────────────────────────────
            const infoRows = [
                ['PETUNJUK PENGISIAN TEMPLATE JADWAL'],
                [''],
                ['CARA ISI:'],
                ['  1. Buka sheet "Template Jadwal".'],
                ['  2. Setiap baris = satu slot waktu.'],
                ['  3. Kolom MAPEL = nama mata pelajaran. Kolom KG = kode singkat guru.'],
                ['  4. Lihat sheet "Daftar Guru" untuk kode guru yang tersedia.'],
                ['  5. Biarkan MAPEL dan KG kosong jika tidak ada pelajaran di slot/kelas itu.'],
                ['  6. Baris ISTRAHAT diabaikan saat impor.'],
                [''],
                ['FORMAT WAKTU:'],
                ['  Gunakan format HH.MM - HH.MM (titik, bukan titik dua).'],
                ['  Contoh: 07.15 - 07.55'],
                ['  Sesuaikan baris waktu jika jadwal sekolah Anda berbeda.'],
                [''],
                ['ATURAN ANTI BENTROK:'],
                ['  ⚠ Satu kode guru TIDAK BOLEH muncul lebih dari satu kali pada baris yang sama.'],
                ['    Satu baris = satu jam pelajaran. Guru bentrok = impor ditolak sistem.'],
            ];

            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws1,                                 'Template Jadwal');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guruRows),  'Daftar Guru');
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(infoRows),  'Petunjuk');
            XLSX.writeFile(wb, 'template_jadwal.xlsx');
        } catch (e) {
            console.error('Gagal generate template:', e);
            alert('Gagal mengunduh template: ' + (e.message ?? e));
        } finally {
            btn.disabled = false;
            btn.textContent = '⬇ Unduh Template Excel';
        }
    });

    document.getElementById('wz-schedule-import').addEventListener('click', async () => {
        const fileInput  = document.getElementById('wz-schedule-file');
        const statusEl   = document.getElementById('wz-schedule-import-status');
        const btn        = document.getElementById('wz-schedule-import');
        const file       = fileInput.files?.[0];
        if (!file) { statusEl.innerHTML = '<div class="alert alert-danger">Pilih file CSV atau Excel terlebih dahulu.</div>'; return; }

        btn.disabled = true;
        btn.textContent = 'Mengimpor…';
        statusEl.innerHTML = '<p class="hint">Memproses file…</p>';

        // Waktu istirahat per hari — skip saat parse flatRows
        const BREAK_SLOTS = new Set([
            '09:55-10:25',  // SENIN, RABU, KAMIS, JUMAT istirahat 1
            '12:25-13:00',  // SENIN, SELASA, RABU, KAMIS istirahat 2
            '09:35-10:05',  // SELASA istirahat 1
        ]);

        try {
            let csvText;
            if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
                const ab  = await file.arrayBuffer();
                const wb  = XLSX.read(ab, { type: 'array' });
                const ws  = wb.Sheets[wb.SheetNames[0]];
                const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

                // Deteksi format lama (sistem): row[1][0] === 'HARI'
                const isOldGrid    = aoa.length >= 2 && String(aoa[1]?.[0] ?? '').toUpperCase() === 'HARI';
                // Deteksi format sekolah: HARI di index 1 (template resmi — col A blank ada)
                // atau index 0 (file sekolah asli tanpa col A — sheet dimension mulai B1 bukan A1).
                const schoolGridOffset =
                    String(aoa[0]?.[1] ?? '').toUpperCase() === 'HARI' ? 1 :
                    String(aoa[0]?.[0] ?? '').toUpperCase() === 'HARI' ? 0 :
                    -1;
                const isSchoolGrid = !isOldGrid && aoa.length >= 3 && schoolGridOffset >= 0;

                const VALID_DAYS = ['SENIN','SELASA','RABU','KAMIS','JUMAT',"JUM'AT",'SABTU'];
                const csvEsc = v => (String(v).includes(',') || String(v).includes('"'))
                    ? `"${String(v).replace(/"/g, '""')}"` : String(v);

                if (isOldGrid) {
                    // Format lama: HARI col 0, MULAI col 1, SELESAI col 2, (KG|Mapel)× dari col 3
                    const kelasNames = [];
                    for (let c = 3; c < (aoa[0]?.length ?? 0); c += 2) {
                        const k = String(aoa[0][c] ?? '').trim();
                        if (k) kelasNames.push(k);
                    }
                    const flatRows = ['kode_guru,nama_mapel,nama_kelas,hari,start_time,end_time'];
                    for (let r = 2; r < aoa.length; r++) {
                        const row  = aoa[r];
                        const hari = String(row[0] ?? '').trim().toUpperCase();
                        if (!VALID_DAYS.includes(hari)) continue;
                        const start = String(row[1] ?? '').trim();
                        const end   = String(row[2] ?? '').trim();
                        for (let ki = 0; ki < kelasNames.length; ki++) {
                            const kg    = String(row[3 + ki * 2] ?? '').trim();
                            const mapel = String(row[4 + ki * 2] ?? '').trim();
                            if (!kg || !mapel) continue;
                            flatRows.push(`${csvEsc(kg)},${csvEsc(mapel)},${csvEsc(kelasNames[ki])},${hari},${start},${end}`);
                        }
                    }
                    if (flatRows.length <= 1) {
                        statusEl.innerHTML = '<div class="alert alert-danger">File Excel belum berisi data jadwal. Isi kolom KG (kode guru) dan Mapel di sheet "Template Jadwal" terlebih dahulu, lalu impor kembali.</div>';
                        return;
                    }
                    csvText = flatRows.join('\n');
                } else if (isSchoolGrid) {
                    // Format sekolah: HARI di col (schoolGridOffset), WAKTU di col (3-schoolGridOffset),
                    // kelas mulai dari col (4-schoolGridOffset). Semua akses kolom dikurangi offset.
                    const kelasNames = [];
                    for (let c = 3 + schoolGridOffset; c < (aoa[0]?.length ?? 0); c += 2) {
                        const k = String(aoa[0][c] ?? '').trim();
                        if (k) kelasNames.push({ name: k, col: c });
                    }
                    const flatRows = ['kode_guru,nama_mapel,nama_kelas,hari,start_time,end_time'];
                    let currentHari = '';
                    const lastKg    = {};  // lastKg[col]    = kode guru terakhir per kolom kelas
                    const lastMapel = {};  // lastMapel[col] = mapel terakhir per kolom kelas
                    // Data mulai baris 2 (baris 0=header, baris 1=MAPEL/KG sub-header)
                    for (let r = 2; r < aoa.length; r++) {
                        const row  = aoa[r];
                        const hariCell = String(row[schoolGridOffset] ?? '').trim().toUpperCase();
                        if (VALID_DAYS.includes(hariCell)) {
                            const newHari = hariCell === "JUM'AT" ? 'JUMAT' : hariCell;
                            if (newHari !== currentHari) {
                                // Reset carry HANYA saat hari benar-benar berganti
                                currentHari = newHari;
                                kelasNames.forEach(({ col }) => { lastKg[col] = ''; lastMapel[col] = ''; });
                            }
                        }
                        if (!currentHari) continue;

                        const waktu = String(row[2 + schoolGridOffset] ?? '').trim();
                        if (!waktu || /istr[ae]hat/i.test(waktu)) {
                            // Reset carry saat istirahat agar slot setelah istirahat tidak carry dari sebelumnya
                            if (/istr[ae]hat/i.test(waktu)) kelasNames.forEach(({ col }) => { lastKg[col] = ''; lastMapel[col] = ''; });
                            continue;
                        }

                        // Waktu format "07.15 - 07.55" → start="07:15", end="07:55"
                        const timeParts = waktu.split(/\s*[-–]\s*/);
                        if (timeParts.length < 2) continue;
                        const start = timeParts[0].trim().replace('.', ':');
                        const end   = timeParts[1].trim().replace('.', ':');
                        if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) continue;
                        if (BREAK_SLOTS.has(`${start}-${end}`)) {
                            kelasNames.forEach(({ col }) => { lastKg[col] = ''; lastMapel[col] = ''; });
                            continue;
                        }

                        for (const { name, col } of kelasNames) {
                            const rawMapel = String(row[col]     ?? '').trim();
                            const rawKg    = String(row[col + 1] ?? '').trim();
                            const kg    = rawKg    || lastKg[col]    || '';
                            const mapel = rawMapel || lastMapel[col] || '';

                            if (rawKg)    lastKg[col]    = rawKg;
                            if (rawMapel) lastMapel[col] = rawMapel;
                            if (!kg) continue;
                            // Abaikan event sekolah penuh (UPACARA, SENAM, dll)
                            if (/upacara|senam|kultum|english day/i.test(mapel)) continue;
                            flatRows.push(`${csvEsc(kg)},${csvEsc(mapel)},${csvEsc(name)},${currentHari},${start},${end}`);
                        }
                    }
                    if (flatRows.length <= 1) {
                        statusEl.innerHTML = '<div class="alert alert-danger">File Excel belum berisi data jadwal. Isi kolom MAPEL dan KG di sheet pertama terlebih dahulu, lalu impor kembali.</div>';
                        return;
                    }
                    csvText = flatRows.join('\n');
                } else {
                    // Format flat (CSV biasa dalam Excel)
                    csvText = XLSX.utils.sheet_to_csv(ws);
                }
            } else {
                csvText = await file.text();
            }
            const result  = await importSchedules(csvText);
            const { total_templates = 0, schedules_generated = 0, failed = 0, errors = [] } = result ?? {};
            if (failed > 0) {
                const errList = errors.slice(0, 5).map(e => `<li>Baris ${e.row}: ${e.message}</li>`).join('');
                statusEl.innerHTML = `<div class="alert alert-danger"><strong>${failed} baris gagal.</strong><ul style="margin:4px 0 0 16px">${errList}${errors.length > 5 ? `<li>…dan ${errors.length - 5} lainnya</li>` : ''}</ul></div>`;
            } else {
                statusEl.innerHTML = `<div class="alert alert-success">✓ Berhasil: ${total_templates} template jadwal, ${schedules_generated} sesi dibuat.</div>`;
            }
            await refreshDataList(10);
        } catch (err) {
            statusEl.innerHTML = `<div class="alert alert-danger">Gagal: ${err.message}</div>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Unggah & Impor';
        }
    });

    await refreshDataList(10);
    nextBtn.disabled = false;
}

const STEP_RENDERERS = {
    1: renderStep1,
    2: renderStep2,
    3: renderStep3,
    4: renderImportStep,
    5: renderImportStep,
    6: renderImportStep,
    7: renderImportStep,
    9: renderStakeholderStep,
    10: renderScheduleStep,
    11: renderForumAssignmentStep,
    12: renderSummaryStep,
};

// ─────────────────────────────────────────────────────────────
// STEP SAVE / VALIDATE
// ─────────────────────────────────────────────────────────────

/**
 * Validasi + simpan langkah aktif. Throw Error (pesan user-facing)
 * jika gagal. Resolve tanpa nilai jika sukses.
 */
async function saveCurrentStep() {
    switch (state.currentStep) {
        case 1: return saveStep1();
        case 2: return saveStep2();
        case 3: return saveStep3();
        // Langkah 4–9 berbasis impor: data tersimpan langsung saat unggah,
        // dan langkah-langkah ini opsional (boleh dilewati / dilanjutkan dari dashboard).
        case 4: case 5: case 6: case 7: case 8: case 9: case 10: case 11: return;
        default: throw new Error('Langkah ini belum tersedia. Gunakan tombol Sebelumnya untuk kembali.');
    }
}

async function saveStep1() {
    const schoolName = document.getElementById('wz-school-name').value.trim();
    const address    = document.getElementById('wz-address').value.trim();

    if (!schoolName) throw new Error('Nama sekolah wajib diisi.');
    if (!address)    throw new Error('Alamat wajib diisi.');

    await upsertSchoolConfig({ school_name: schoolName, address });

    state.data.schoolName = schoolName;
    state.data.address    = address;
}

async function saveStep2() {
    // Mode read-only: tidak ada form DOM, data sudah diisi oleh renderStep2
    if (!document.getElementById('wz-academic-year')) return;

    const academicYear = document.getElementById('wz-academic-year').value.trim();
    const semesterEl   = document.querySelector('input[name="wz-semester"]:checked');
    const startDate    = document.getElementById('wz-start-date').value;
    const endDate      = document.getElementById('wz-end-date').value;

    if (!/^\d{4}\/\d{4}$/.test(academicYear)) {
        throw new Error('Format tahun ajaran harus YYYY/YYYY (contoh: 2026/2027).');
    }
    if (!semesterEl)            throw new Error('Pilih semester (Ganjil atau Genap).');
    if (!startDate)             throw new Error('Tanggal mulai wajib diisi.');
    if (!endDate)               throw new Error('Tanggal selesai wajib diisi.');
    if (endDate <= startDate)   throw new Error('Tanggal selesai harus setelah tanggal mulai.');

    const semester = semesterEl.value; // '1' | '2'

    // INSERT/UPSERT academic_periods — belum ada helper di api.js,
    // jadi pakai client langsung. uq_academic_period UNIQUE
    // (academic_year, semester) jadi target ON CONFLICT.
    const { error: periodErr } = await supabase
        .from('academic_periods')
        .upsert(
            {
                school_id:     state.schoolId,
                academic_year: academicYear,
                semester,
                start_date:    startDate,
                end_date:      endDate,
                status:        'ACTIVE',
            },
            { onConflict: 'school_id,academic_year,semester' },
        );
    if (periodErr) throw new Error(periodErr.message);

    // UPDATE school_config: tandai periode aktif
    const prevConfig = await getSchoolConfig().catch(() => null);
    const prevYear   = prevConfig?.current_academic_year;

    await upsertSchoolConfig({
        current_academic_year: academicYear,
        current_semester:      semester,
    });

    // Sinkronkan classes jika tahun ajaran berubah
    if (prevYear && prevYear !== academicYear) {
        await supabase
            .from('classes')
            .update({ academic_year: academicYear })
            .eq('academic_year', prevYear);
    }

    state.data.academicYear = academicYear;
    state.data.semester     = semester;
    state.data.startDate    = startDate;
    state.data.endDate      = endDate;
}

async function saveStep3() {
    // Program disimpan real-time per item; di sini cukup validasi count dari DB.
    const programs = await getPrograms();
    if (programs.length === 0) {
        throw new Error('Tambahkan minimal satu Program Keahlian.');
    }
}

async function finishSetup() {
    await markSetupCompleted(); // upsert school_config setup_completed = true
    window.location.replace('dashboard.html');
}

// ─────────────────────────────────────────────────────────────
// BUTTON WIRING
// ─────────────────────────────────────────────────────────────

async function withLoading(fn) {
    nextBtn.disabled = true;
    prevBtn.disabled = true;
    const prevLabel = nextBtn.textContent;
    nextBtn.textContent = 'Menyimpan…';
    try {
        await fn();
    } finally {
        nextBtn.textContent = prevLabel;
        syncFooter(); // pulihkan state disabled prev sesuai langkah
    }
}

nextBtn.addEventListener('click', async () => {
    clearError();

    if (state.currentStep === TOTAL_STEPS) {
        await withLoading(async () => {
            try {
                await finishSetup();
            } catch (err) {
                showError(err.message ?? 'Gagal menyelesaikan setup.');
                nextBtn.disabled = false; // pulihkan: gagal, izinkan coba lagi
            }
        });
        return;
    }

    await withLoading(async () => {
        try {
            await saveCurrentStep();
        } catch (err) {
            showError(err.message ?? 'Terjadi kesalahan. Coba lagi.');
            nextBtn.disabled = false; // pulihkan: validasi gagal, izinkan coba lagi
            return;
        }
        markDone(state.currentStep);
        await goToStep(nextValidStep(state.currentStep));
    });
});

prevBtn.addEventListener('click', async () => {
    if (state.currentStep === 1) return;
    await goToStep(prevValidStep(state.currentStep));
});

// Klik item sidebar — hanya ke langkah yang sudah selesai
document.getElementById('wizard-steps').addEventListener('click', async (e) => {
    const item = e.target.closest('.wz-step-item');
    if (!item) return;
    const step = Number(item.dataset.step);
    if (!state.completedSteps.has(step)) return;
    await goToStep(step);
});

// ─────────────────────────────────────────────────────────────
// SMALL UTILS
// ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
// CSV TEMPLATES (unduh contoh format per langkah)
// ─────────────────────────────────────────────────────────────

// Kolom HARUS sama persis dengan kontrak edge function bulk-import-*.
// role_type untuk Guru (5) disuntik client-side (lihat importFnForStep),
// jadi tidak ada di template.
const EXCEL_TEMPLATES = {
    4: { filename: 'template_kelas.xlsx',
         headers: ['nama_kelas', 'kode_program', 'tingkat'],
         exampleRows: [
             ['X TKJ 1', 'TKJ', '10'],
             ['XI AKL 1', 'AKL', '11'],
         ],
         guide: [
             ['PETUNJUK PENGISIAN — KELAS & ROMBEL', '', ''],
             ['', '', ''],
             ['Kolom', 'Wajib?', 'Penjelasan'],
             ['nama_kelas', 'Wajib', 'Nama kelas lengkap. Contoh: X TKJ 1, XI AKL 2. Setiap nama harus berbeda.'],
             ['kode_program', 'Wajib', 'Kode program keahlian. Contoh: TKJ, AKL. Pastikan kode sudah diinput di langkah Program Keahlian.'],
             ['tingkat', 'Wajib', 'Isi angka: 10 untuk kelas X, 11 untuk kelas XI, 12 untuk kelas XII.'],
             ['', '', ''],
             ['PENTING', '', ''],
             ['•', '', 'Upload ulang file yang sama akan memperbarui program dan tingkat. Data yang sudah ada tidak diduplikasi.'],
             ['•', '', 'Jika nama kelas salah, klik tombol edit (✎) di halaman wizard untuk memperbaiki.'],
             ['•', '', 'Tahun ajaran diambil otomatis dari Profil Sekolah.'],
         ] },
    5: { filename: 'template_staf.xlsx',
         headers: ['nama', 'nip_atau_nik', 'mengajar', 'teacher_code', 'wali_kelas', 'jabatan', 'allow_parallel'],
         exampleRows: [
             ['Budi Santoso, S.Pd', '198501012010011001', 'YA', 'BSS', '', '', ''],
             ['Ririn Novianti, S.Pd', '198812052015032001', 'YA', 'RRN', 'XII TKJ 1', '', ''],
             ['Ahmad Fauzi, M.Pd', '196811051994031005', '', '', '', 'KEPSEK', ''],
             ['Susi Marlina, S.Pd', '198501032010012003', '', '', '', 'WAKA_KURIKULUM', ''],
             ['Dewi Lestari, S.Pd', '198903152012032001', 'YA', 'DWL', '', 'BK', ''],
         ],
         guide: [
             ['PETUNJUK PENGISIAN — STAF & PERAN', '', ''],
             ['', '', ''],
             ['Kolom', 'Wajib?', 'Penjelasan'],
             ['nama', 'Wajib', 'Nama lengkap beserta gelar.'],
             ['nip_atau_nik', 'Wajib', 'NIP atau NIK. Digunakan untuk login. Setiap NIP/NIK harus berbeda.'],
             ['mengajar', 'Opsional', 'Isi YA jika staf ini mengajar di kelas. Kosongkan jika tidak mengajar (contoh: Kepsek, Waka).'],
             ['teacher_code', 'Opsional', 'Kode singkat guru untuk jadwal (contoh: BSS, RRN). Jika mengajar=YA tapi kolom ini kosong, sistem akan buatkan kode otomatis.'],
             ['wali_kelas', 'Opsional', 'Isi nama kelas jika staf ini wali kelas. Contoh: XII TKJ 1. Nama kelas harus sudah ada di langkah Kelas.'],
             ['jabatan', 'Opsional', 'Jabatan tambahan. Jika lebih dari satu, pisahkan dengan koma. Pilihan: BK, KEPSEK, WAKA_KURIKULUM, WAKA_KESISWAAN'],
             ['allow_parallel', 'Opsional', 'Isi YA jika guru boleh mengajar paralel (moving class / team teaching). Kosongkan untuk guru biasa.'],
             ['', '', ''],
             ['PENTING', '', ''],
             ['•', '', 'Staf yang mengajar (mengajar=YA) akan muncul di jadwal dan bisa diassign ke kelas.'],
             ['•', '', 'Staf yang tidak mengajar (mengajar kosong) tetap bisa login sesuai jabatannya, tapi tidak muncul di jadwal.'],
             ['•', '', 'Satu staf bisa punya beberapa jabatan sekaligus. Contoh: guru yang juga BK → isi mengajar=YA dan jabatan=BK.'],
             ['•', '', 'Upload ulang file yang sama akan memperbarui data. Jika NIP salah, klik tombol edit (✎) atau hapus lalu impor ulang.'],
         ] },
    6: { filename: 'template_siswa.xlsx',
         headers: ['nama', 'nis', 'kode_program', 'class_name'],
         exampleRows: [
             ['Ani Rahayu', '2024001', 'TKJ', 'X TKJ 1'],
             ['Doni Pratama', '2024002', 'AKL', 'XI AKL 1'],
         ],
         guide: [
             ['PETUNJUK PENGISIAN — SISWA', '', ''],
             ['', '', ''],
             ['Kolom', 'Wajib?', 'Penjelasan'],
             ['nama', 'Wajib', 'Nama lengkap siswa.'],
             ['nis', 'Wajib', 'Nomor Induk Siswa. Setiap NIS harus berbeda. Jika NIS diawali angka 0, pastikan kolom diformat sebagai Teks di Excel.'],
             ['kode_program', 'Wajib', 'Kode program keahlian. Contoh: TKJ, AKL. Pastikan kode sudah ada di langkah Program Keahlian.'],
             ['class_name', 'Wajib', 'Nama kelas. Contoh: X TKJ 1. Pastikan nama kelas sudah ada di langkah Kelas & Rombel.'],
             ['', '', ''],
             ['PENTING', '', ''],
             ['•', '', 'Upload ulang file yang sama akan memperbarui nama, program, dan kelas. NIS yang sudah ada tidak diduplikasi.'],
             ['•', '', 'Jika NIS salah, klik tombol edit (✎) di halaman wizard atau hapus lalu impor ulang.'],
             ['•', '', 'Tahun ajaran dan semester diambil otomatis dari Profil Sekolah.'],
         ] },
    7: { filename: 'template_orang_tua.xlsx',
         headers: ['nama_ortu', 'nik', 'nis_siswa'],
         exampleRows: [
             ['Bambang Wijaya', '3201012003800001', '2024001'],
             ['Bambang Wijaya', '3201012003800001', '2024002'],
         ],
         guide: [
             ['PETUNJUK PENGISIAN — ORANG TUA', '', ''],
             ['', '', ''],
             ['Kolom', 'Wajib?', 'Penjelasan'],
             ['nama_ortu', 'Wajib', 'Nama lengkap orang tua atau wali.'],
             ['nik', 'Wajib', 'NIK orang tua. Digunakan untuk login di Portal Orang Tua. Jika diawali 0, pastikan diformat sebagai Teks di Excel.'],
             ['nis_siswa', 'Wajib', 'NIS anak. Pastikan NIS sudah ada di langkah Siswa.'],
             ['', '', ''],
             ['PENTING', '', ''],
             ['•', '', 'Satu orang tua punya beberapa anak? Tulis NIK yang sama di beberapa baris, masing-masing dengan NIS anak yang berbeda.'],
             ['•', '', 'Orang tua login di Portal Orang Tua menggunakan NIK + password. Setelah login, orang tua bisa melihat data semua anaknya.'],
             ['•', '', 'Upload ulang file yang sama akan memperbarui nama. Jika NIK salah, hapus lalu impor ulang.'],
         ] },
    11: {
        filename: 'template_penugasan_forum.xlsx',
        sheets: {
            bk: {
                name: 'Template BK',
                headers: ['nama_kelas', 'kode_program', 'nip_bk'],
                exampleRows: [
                    ['X TKJ 1', 'TKJ', '202620270001'],
                ],
                guide: [
                    ['PETUNJUK PENGISIAN — PENUGASAN BK KE KELAS', '', ''],
                    ['', '', ''],
                    ['Kolom', 'Wajib?', 'Penjelasan'],
                    ['nama_kelas', 'Wajib', 'Nama kelas. Contoh: X TKJ 1. Harus sudah ada di langkah Kelas & Rombel.'],
                    ['kode_program', 'Wajib', 'Kode program keahlian. Contoh: TKJ. Harus sudah ada di langkah Program Keahlian.'],
                    ['nip_bk', 'Wajib', 'NIP guru BK yang ditugaskan ke kelas ini.'],
                    ['', '', ''],
                    ['PENTING', '', ''],
                    ['•', '', 'Satu kelas boleh ditugaskan ke lebih dari satu BK (tambah baris terpisah).'],
                    ['•', '', 'Upload ulang baris yang sama akan dilewati (tidak diduplikasi).'],
                ],
            },
            gw: {
                name: 'Template Guru Wali',
                headers: ['nis_siswa', 'nip_guru_wali'],
                exampleRows: [
                    ['0091234567', '202620270075'],
                ],
                guide: [
                    ['PETUNJUK PENGISIAN — PENUGASAN GURU WALI KE SISWA', '', ''],
                    ['', '', ''],
                    ['Kolom', 'Wajib?', 'Penjelasan'],
                    ['nis_siswa', 'Wajib', 'NIS siswa. Harus sudah ada di langkah Siswa.'],
                    ['nip_guru_wali', 'Wajib', 'NIP guru yang menjadi Guru Wali siswa tersebut.'],
                    ['', '', ''],
                    ['PENTING', '', ''],
                    ['•', '', 'Satu siswa hanya boleh punya satu Guru Wali aktif per tahun ajaran.'],
                    ['•', '', 'Upload ulang baris yang sama akan dilewati (tidak diduplikasi).'],
                ],
            },
        },
    },
};

/** HTML tombol unduh template untuk langkah tertentu (kosong jika tak ada config). */
function templateButtonHtml(step) {
    if (!EXCEL_TEMPLATES[step]) return '';
    return `<button type="button" class="btn btn-primary wz-template-btn" style="margin-bottom:16px">↓ Unduh Template Excel</button>`;
}

/** Pasang handler unduh ke tombol template langkah aktif (jika ada). */
function wireTemplateButton(step) {
    const cfg = EXCEL_TEMPLATES[step];
    if (!cfg) return;
    const btn = contentEl.querySelector('.wz-template-btn');
    if (btn) {
        btn.addEventListener('click', () =>
            generateExcelTemplate(cfg.filename, cfg.headers, cfg.exampleRows, cfg.guide));
    }
}

/** Generate file Excel (.xlsx) dari headers + exampleRows via SheetJS,
 *  lalu trigger unduhan di browser. Membutuhkan global XLSX (CDN). */
function generateExcelTemplate(filename, headers, exampleRows, guide) {
    if (typeof XLSX === 'undefined') {
        showError('Fitur unduh template membutuhkan koneksi internet.');
        return;
    }
    const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);

    const PAD_ROWS = 300;
    const ncols = headers.length;
    for (let R = 0; R <= PAD_ROWS; R++) {
        for (let C = 0; C < ncols; C++) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            const cell = ws[addr] ?? { t: 's', v: '' };
            cell.t = 's';
            cell.z = '@';
            ws[addr] = cell;
        }
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: PAD_ROWS, c: ncols - 1 } });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DATA');

    if (guide) {
        const gsw = XLSX.utils.aoa_to_sheet(guide);
        XLSX.utils.book_append_sheet(wb, gsw, 'PETUNJUK');
    }

    XLSX.writeFile(wb, filename);
}

// ─────────────────────────────────────────────────────────────
// BULK IMPORT (unggah Excel/CSV → edge function)
// ─────────────────────────────────────────────────────────────

const IMPORT_STEP_INFO = {
    4: { title: 'Kelas & Rombel',
         desc: 'Unduh template, isi data, lalu unggah. Panduan pengisian ada di sheet PETUNJUK dalam template.' },
    5: { title: 'Staf & Peran',
         desc: 'Unduh template, isi data, lalu unggah. Panduan pengisian ada di sheet PETUNJUK dalam template.' },
    6: { title: 'Siswa',
         desc: 'Unduh template, isi data, lalu unggah. Panduan pengisian ada di sheet PETUNJUK dalam template.' },
    7: { title: 'Orang Tua',
         desc: 'Unduh template, isi data, lalu unggah. Panduan pengisian ada di sheet PETUNJUK dalam template.' },
    11: {
        title: 'Penugasan Forum Kelas',
        desc: 'Impor penugasan BK per kelas dan Guru Wali per siswa. Gunakan dua template terpisah.',
    },
};

/** Fungsi impor (edge function) untuk tiap langkah. Guru menyuntikkan
 *  role_type karena perannya tersirat dari langkah. */
function importFnForStep(step) {
    switch (step) {
        case 3: return importPrograms;
        case 4: return importClasses;
        case 5: return importUsers;
        case 6: return importStudents;
        case 7: return importParents;
        case 11: // ditangani manual di renderForumAssignmentStep
            return null;
        default: throw new Error(`Tidak ada importer untuk langkah ${step}`);
    }
}

/** Tambah satu kolom konstan ke setiap baris data CSV (mis. role_type).
 *  Hanya menempel kolom di akhir tiap baris, jadi aman terhadap quoting. */
function injectColumn(csvText, columnName, value, defaultOnly = false) {
    const lines = csvText.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return csvText;
    // Kalau kolom sudah ada di header, jangan inject
    if (defaultOnly && lines[0].toLowerCase().includes(columnName.toLowerCase())) return csvText;
    const header = `${lines[0]},${columnName}`;
    const dataLines = lines.slice(1).map(line => `${line},${value}`);
    return [header, ...dataLines].join('\r\n');
}

/** Baca file unggahan (.xlsx/.xls/.csv) menjadi teks CSV.
 *  Excel dikonversi via SheetJS (global XLSX dari CDN di wizard.html). */
async function fileToCsv(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        if (typeof XLSX === 'undefined') {
            throw new Error('Pustaka Excel gagal dimuat. Periksa koneksi internet, atau unggah file CSV.');
        }
        const buf = await file.arrayBuffer();
        const wb  = XLSX.read(buf, { type: 'array' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        stripLeadingApostropheCells(ws);
        return XLSX.utils.sheet_to_csv(ws);
    }
    return stripLeadingApostropheCsv(await file.text());
}

/** Buang tanda kutip satu di awal nilai sel (penanda teks Excel yang
 *  kadang ikut tersimpan), agar NIP/NIS tidak berawalan '. */
function stripLeadingApostropheCells(ws) {
    Object.keys(ws).forEach(addr => {
        if (addr[0] === '!') return;
        const cell = ws[addr];
        if (cell && typeof cell.v === 'string' && cell.v.startsWith("'")) {
            cell.v = cell.v.replace(/^'+/, '');
            delete cell.w; // buang teks ter-cache agar nilai baru yang dipakai
        }
    });
}

/** Versi CSV: hapus ' di awal baris atau tepat setelah pemisah koma. */
function stripLeadingApostropheCsv(text) {
    return text.replace(/(^|,)'+/gm, '$1');
}

/** Buang baris yang seluruh selnya kosong (sisa baris kosong di Excel). */
function stripEmptyCsvLines(csv) {
    return csv
        .split(/\r\n|\n|\r/)
        .filter(line => line.split(',').some(cell => cell.trim().length > 0))
        .join('\r\n');
}

/** HTML blok unggah: input file + tombol impor + area hasil. */
function importBlockHtml(step) {
    const headers = EXCEL_TEMPLATES[step]?.headers ?? [];
    const hasIdentifier = headers.some(h => ['nip_atau_nik', 'nis', 'nik', 'nis_siswa'].includes(h));
    const idTip = hasIdentifier
        ? `<p class="hint" style="margin-top:8px">Jika NIP/NIS panjang berubah jadi angka di Excel, format kolomnya sebagai <b>Teks</b> atau awali dengan tanda kutip satu (<code>'</code>) — tanda itu otomatis dihapus saat impor.</p>`
        : '';
    return `
        <div class="wz-import">
            <p class="hint">Kolom yang diharapkan: <code>${headers.join(', ')}</code></p>
            <input type="file" class="input wz-file-input" accept=".xlsx,.xls,.csv"
                style="padding:8px; margin-bottom:12px" />
            <button type="button" class="btn btn-primary wz-import-btn" disabled>Unggah &amp; Impor</button>
            ${idTip}
            <div class="wz-import-result" style="margin-top:16px"></div>
        </div>
    `;
}

/** Pasang handler unggah+impor pada blok yang dirender importBlockHtml. */
function wireImportBlock(step, { importFn, onDone } = {}) {
    const fn        = importFn ?? importFnForStep(step);
    const fileInput = contentEl.querySelector('.wz-file-input');
    const importBtn = contentEl.querySelector('.wz-import-btn');
    const resultEl  = contentEl.querySelector('.wz-import-result');
    if (!fileInput || !importBtn || !resultEl) return;

    let csvText = null;

    function resetImportBtn() {
        importBtn.disabled = !csvText;
        importBtn.textContent = 'Unggah & Impor';
        importBtn.classList.remove('btn-success');
        importBtn.classList.add('btn-primary');
    }

    fileInput.addEventListener('change', async () => {
        resultEl.innerHTML = '';
        const file = fileInput.files?.[0];
        if (!file) { csvText = null; resetImportBtn(); return; }
        try {
            csvText = stripEmptyCsvLines(await fileToCsv(file));
            if (!csvText.trim()) throw new Error('File kosong atau tidak ada baris data.');
            resetImportBtn();
        } catch (err) {
            csvText = null;
            resetImportBtn();
            resultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Gagal membaca file.')}</div>`;
        }
    });

    importBtn.addEventListener('click', async () => {
        if (!csvText) return;
        importBtn.disabled = true;
        fileInput.disabled = true;
        resultEl.innerHTML = '';

        importRunning = true;
        const rowCount = csvText.split(/\r\n|\n|\r/).filter(l => l.trim()).length - 1;
        let dots = 0;
        const ticker = setInterval(() => {
            dots = (dots + 1) % 4;
            importBtn.textContent = `Mengimpor ${rowCount} baris${'.'.repeat(dots)}`;
        }, 400);
        try {
            const result = await fn(csvText);
            clearInterval(ticker);
            renderImportResult(resultEl, result);
            const changed = (result?.success ?? 0) > 0 || (result?.updated ?? 0) > 0;
            if (changed) {
                importBtn.textContent = '✓ Impor Selesai';
                importBtn.classList.remove('btn-primary');
                importBtn.classList.add('btn-success');
                importBtn.disabled = true;
            } else {
                resetImportBtn();
            }
            fileInput.disabled = false;
            importRunning = false;
            if (onDone) await onDone(result);
        } catch (err) {
            clearInterval(ticker);
            resultEl.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Impor gagal.')}</div>`;
            resetImportBtn();
            fileInput.disabled = false;
            importRunning = false;
        }
    });
}

/** Render ringkasan + tabel error/konflik hasil impor. */
function renderImportResult(el, result) {
    const { total = 0, success = 0, updated = 0, failed = 0, errors = [], conflicts = [] } = result ?? {};
    const problems = [...errors, ...conflicts];
    const allGood  = failed === 0 && problems.length === 0;

    const summary = `Total ${total} baris — berhasil ${success}` +
        (updated ? `, diperbarui ${updated}` : '') +
        `, gagal ${failed}` +
        (conflicts.length ? `, konflik ${conflicts.length}` : '') + '.';

    let html = `<div class="alert ${allGood ? 'alert-success' : 'alert-warning'}">${escapeHtml(summary)}</div>`;
    if (problems.length) {
        html += `
            <table class="table">
                <thead><tr><th style="width:64px">Baris</th><th>Pesan</th></tr></thead>
                <tbody>${problems.map(e => `<tr><td>${e.row ?? '-'}</td><td>${escapeHtml(e.message ?? '')}</td></tr>`).join('')}</tbody>
            </table>`;
    }
    el.innerHTML = html;
}

/** Renderer generik untuk langkah berbasis impor (4–8). */
async function renderImportStep() {
    const step = state.currentStep;
    const info = IMPORT_STEP_INFO[step] ?? { title: STEP_NAMES[step], desc: '' };

    contentEl.innerHTML = `
        <div class="step-label">Langkah ${step} dari ${TOTAL_STEPS}</div>
        <h3>${info.title}</h3>
        <p class="hint">${info.desc}</p>
        ${templateButtonHtml(step)}
        <div class="wz-data-list" id="wz-data-list"><p class="hint">Memuat data…</p></div>
        <hr style="margin:24px 0;border:none;border-top:1px solid var(--color-border)" />
        <h4 style="margin:0 0 8px">Impor dari file</h4>
        ${importBlockHtml(step)}
    `;
    wireTemplateButton(step);
    wireImportBlock(step, { onDone: () => refreshDataList(step) });
    await refreshDataList(step);

    // Langkah impor bersifat opsional — boleh dilanjutkan tanpa unggah.
    nextBtn.disabled = false;
}

// ── Daftar data terkini per langkah (tampil + hapus) ──────────

const STEP_LIST = {
    3: {
        title: 'Program terdaftar',
        headers: ['Kode', 'Nama Program'],
        deleteTable: 'programs',
        editFields: [
            { key: 'code', label: 'Kode Program' },
            { key: 'name', label: 'Nama Program' },
        ],
        save: (id, vals, oldData) => updateProgram(id, vals, oldData?.code),
        fetch: async () => {
            const data = await getPrograms();
            return data.map(p => ({ id: p.program_id, cells: [p.code, p.name], editData: { code: p.code, name: p.name } }));
        },
    },
    4: {
        title: 'Kelas terdaftar',
        headers: ['Nama Kelas', 'Tingkat'],
        deleteTable: 'classes',
        groupBy: 'group',
        editFields: [
            { key: 'name', label: 'Nama Kelas' },
        ],
        save: (id, vals) => updateClass(id, vals),
        fetch: async () => {
            const [classes, programs] = await Promise.all([getClasses(), getPrograms()]);
            const pm = new Map(programs.map(p => [p.program_id, p.code]));
            const pn = new Map(programs.map(p => [p.program_id, p.name]));
            return classes.map(c => ({
                id: c.class_id,
                cells: [c.name, c.grade_level],
                group: pn.get(c.program_id) ?? '—',
                editData: { name: c.name },
            }));
        },
    },
    5: {
        title: 'Staf terdaftar',
        headers: ['Nama', 'NIP/NIK', 'Kode', 'Jabatan'],
        deleteTable: 'users',
        editFields: [
            { key: 'full_name', label: 'Nama' },
            { key: 'login_identifier', label: 'NIP/NIK' },
            { key: 'teacher_code', label: 'Kode Guru' },
        ],
        save: (id, vals) => updateUserIdentifier(id, vals),
        fetch: async () => {
            const data = await fetchAllRows('users',
                q => q.select('user_id, full_name, login_identifier, teacher_code, role_type, is_bk, is_kepsek, is_waka_kurikulum, is_waka_kesiswaan, wali_kelas_class_id')
                      .not('role_type', 'in', '("SISWA","ORTU","ADMINISTRATIVE")')
                      .is('deleted_at', null)
                      .order('full_name'));
            return data.map(u => {
                const jabatan = [];
                if (u.role_type === 'GURU' || u.teacher_code) jabatan.push('Guru');
                if (u.wali_kelas_class_id) jabatan.push('Wali Kelas');
                if (u.is_bk) jabatan.push('BK');
                if (u.is_kepsek) jabatan.push('Kepsek');
                if (u.is_waka_kurikulum) jabatan.push('Waka Kurikulum');
                if (u.is_waka_kesiswaan) jabatan.push('Waka Kesiswaan');
                if (u.role_type === 'STAKEHOLDER') jabatan.push('Stakeholder');
                return {
                    id: u.user_id,
                    cells: [u.full_name, u.login_identifier, u.teacher_code ?? '—', jabatan.join(', ') || u.role_type],
                    editData: { full_name: u.full_name, login_identifier: u.login_identifier, teacher_code: u.teacher_code ?? '' },
                };
            });
        },
    },
    6: {
        title: 'Siswa aktif',
        headers: ['Nama', 'NIS'],
        deleteTable: 'students',
        nestedGroup: true,
        editFields: [
            { key: 'full_name', label: 'Nama' },
            { key: 'nis', label: 'NIS' },
        ],
        save: (id, vals) => updateStudent(id, vals),
        fetch: async () => {
            const config = await getSchoolConfig();
            const ay = config?.current_academic_year;
            const data = await fetchAllRows('students',
                q => q.select(`student_id, full_name, nis, student_status,
                    program:programs ( name ),
                    enrollment:class_enrollments ( class:classes ( name, academic_year ) )
                `).eq('student_status', 'AKTIF')
                  .order('full_name'));
            return data.map(s => {
                const enrollments = Array.isArray(s.enrollment) ? s.enrollment : (s.enrollment ? [s.enrollment] : []);
                const currentEnrollment = enrollments.find(e => e.class?.academic_year === ay) ?? enrollments[0];
                return {
                    id: s.student_id,
                    cells: [s.full_name, s.nis],
                    editData: { full_name: s.full_name, nis: s.nis },
                    program: s.program?.name ?? 'Tanpa program',
                    kelas: currentEnrollment?.class?.name ?? 'Belum ada kelas',
                };
            });
        },
        afterRender: async (el) => {
            await renderEmptyClassesNotice(el);
            await renderAlumniSection(el);
        },
    },
    7: {
        title: 'Orang Tua (siswa aktif)',
        headers: ['Nama', 'NIK', 'Anak'],
        deleteTable: 'users',
        nestedGroup: true,
        editFields: [
            { key: 'full_name', label: 'Nama' },
            { key: 'login_identifier', label: 'NIK' },
        ],
        save: (id, vals) => updateUserIdentifier(id, vals),
        fetch: async () => {
            const parents = await fetchAllRows('users',
                q => q.select('user_id, full_name, login_identifier')
                      .eq('role_type', 'ORTU')
                      .is('deleted_at', null)
                      .order('full_name'));
            if (parents.length === 0) return [];

            const config = await getSchoolConfig();
            const ay = config?.current_academic_year;

            const links = await fetchAllRows('student_parents',
                q => q.select(`parent_user_id, students ( full_name, student_status,
                    program:programs ( name ),
                    enrollment:class_enrollments ( class:classes ( name, academic_year ) )
                )`));

            const parentChildMap = new Map();
            for (const link of links) {
                const pid = link.parent_user_id;
                if (!parentChildMap.has(pid)) parentChildMap.set(pid, []);
                const enrollments = Array.isArray(link.students?.enrollment) ? link.students.enrollment : (link.students?.enrollment ? [link.students.enrollment] : []);
                const currentEnrollment = enrollments.find(e => e.class?.academic_year === ay) ?? enrollments[0];
                parentChildMap.get(pid).push({
                    name: link.students?.full_name,
                    status: link.students?.student_status,
                    program: link.students?.program?.name ?? 'Tanpa program',
                    kelas: currentEnrollment?.class?.name ?? 'Belum ada kelas',
                });
            }

            return parents
                .map(u => {
                    const children = parentChildMap.get(u.user_id) ?? [];
                    const aktifChildren = children.filter(c => c.status === 'AKTIF');
                    if (aktifChildren.length === 0) return null; // semua anak lulus — masuk section Alumni
                    const childNames = aktifChildren.map(c => c.name).join(', ') || '—';
                    return {
                        id: u.user_id,
                        cells: [u.full_name, u.login_identifier, childNames],
                        editData: { full_name: u.full_name, login_identifier: u.login_identifier },
                        program: aktifChildren[0]?.program ?? 'Tanpa program',
                        kelas: aktifChildren[0]?.kelas ?? 'Belum ada kelas',
                    };
                })
                .filter(Boolean);
        },
        afterRender: renderAlumniParentsSection,
    },
    9: {
        title: 'Stakeholder terdaftar',
        emptyHint: 'Gunakan form di bawah untuk menambahkan.',
        headers: ['Nama', 'Kode Login'],
        deleteTable: 'users',
        editFields: [
            { key: 'full_name', label: 'Nama' },
            { key: 'login_identifier', label: 'Kode Login' },
        ],
        save: (id, vals) => updateUserIdentifier(id, vals),
        fetch: async () => {
            const data = await fetchAllRows('users',
                q => q.select('user_id, full_name, login_identifier')
                      .eq('role_type', 'STAKEHOLDER')
                      .is('deleted_at', null)
                      .order('full_name'));
            return data.map(u => ({
                id: u.user_id,
                cells: [u.full_name, u.login_identifier],
                editData: { full_name: u.full_name, login_identifier: u.login_identifier },
            }));
        },
    },
    10: {
        title: 'Jadwal terdaftar',
        headers: ['Tanggal', 'Waktu', 'Kelas', 'Guru'],
        deleteTable: 'teaching_schedules',
        emptyHint: 'Jadwal belum perlu diisi sekarang. Setelah wizard selesai, susun jadwal via menu Jadwal Pelajaran di dashboard, atau impor file CSV di atas.',
        fetch: async () => {
            const data = await fetchAllRows('teaching_schedules',
                q => q.select(`
                    schedule_id, session_date, session_start, session_end,
                    class:classes ( name ),
                    teacher:users ( full_name )
                `).order('session_date', { ascending: false }));
            return data.map(s => ({
                id: s.schedule_id,
                cells: [
                    s.session_date,
                    `${s.session_start?.slice(0,5)}–${s.session_end?.slice(0,5)}`,
                    s.class?.name ?? '—',
                    s.teacher?.full_name ?? '—',
                ],
            }));
        },
    },
};

/** Ambil users untuk satu role lalu petakan tiap baris ke sel tabel.
 *  Mem-paginasi (fetchAllRows) agar daftar ribuan (mis. ORTU) tidak terpotong
 *  di 1000 dan jumlah yang tampil akurat. */
async function fetchUsersByRole(roleType, toCells, toEditData) {
    const data = await fetchAllRows('users',
        q => q.select('user_id, full_name, login_identifier, teacher_code, wali_kelas_class_id')
              .eq('role_type', roleType)
              .is('deleted_at', null)
              .order('full_name'));
    return data.map(u => {
        const row = { id: u.user_id, cells: toCells(u) };
        if (toEditData) row.editData = toEditData(u);
        return row;
    });
}

// ── Kelas Kosong Notice (kelas tahun ajaran aktif tanpa siswa) ─

async function renderEmptyClassesNotice(parentEl) {
    const config = await getSchoolConfig();
    const ay = config?.current_academic_year;
    if (!ay) return;

    const [classes, enrollments] = await Promise.all([
        fetchAllRows('classes',
            q => q.select('class_id, name, grade_level, program:programs ( name )')
                  .eq('academic_year', ay)
                  .order('name')),
        fetchAllRows('class_enrollments',
            q => q.select('class_id').is('withdrawn_at', null)),
    ]);

    const enrolledClassIds = new Set(enrollments.map(e => e.class_id));
    const emptyClasses = classes.filter(c => !enrolledClassIds.has(c.class_id));
    if (emptyClasses.length === 0) return;

    const byProgram = new Map();
    for (const c of emptyClasses) {
        const prog = c.program?.name ?? 'Tanpa program';
        if (!byProgram.has(prog)) byProgram.set(prog, []);
        byProgram.get(prog).push(c.name);
    }
    const list = [...byProgram.entries()]
        .sort(([a], [b]) => a.localeCompare(b, 'id'))
        .map(([prog, names]) => `<li><strong>${escapeHtml(prog)}</strong>: ${names.map(escapeHtml).join(', ')}</li>`)
        .join('');

    parentEl.insertAdjacentHTML('afterbegin', `
        <div class="alert alert-warning" style="margin-bottom:16px">
            <strong>${emptyClasses.length} kelas tahun ajaran ${escapeHtml(ay)} belum ada siswa</strong>
            — kelas ini tidak muncul di daftar di bawah sampai siswa diimpor.
            <ul style="margin:8px 0 0">${list}</ul>
        </div>
    `);
}

// ── Alumni Parents Section (ortu yang SEMUA anaknya LULUS) ───

async function renderAlumniParentsSection(parentEl) {
    const parents = await fetchAllRows('users',
        q => q.select('user_id, full_name, login_identifier')
              .eq('role_type', 'ORTU')
              .is('deleted_at', null)
              .order('full_name'));
    if (parents.length === 0) return;

    const links = await fetchAllRows('student_parents',
        q => q.select(`parent_user_id, students ( full_name, student_status, graduated_academic_year )`));

    const parentChildMap = new Map();
    for (const link of links) {
        const pid = link.parent_user_id;
        if (!parentChildMap.has(pid)) parentChildMap.set(pid, []);
        parentChildMap.get(pid).push(link.students);
    }

    const alumniParents = parents
        .map(u => {
            const children = (parentChildMap.get(u.user_id) ?? []).filter(Boolean);
            if (children.length === 0) return null;
            const allLulus = children.every(c => c.student_status === 'LULUS');
            if (!allLulus) return null;
            const latestYear = children
                .map(c => c.graduated_academic_year)
                .sort()
                .reverse()[0] ?? 'Tidak diketahui';
            return { ...u, children, year: latestYear };
        })
        .filter(Boolean);

    if (alumniParents.length === 0) return;

    const byYear = new Map();
    for (const p of alumniParents) {
        if (!byYear.has(p.year)) byYear.set(p.year, []);
        byYear.get(p.year).push(p);
    }
    const sortedYears = [...byYear.keys()].sort().reverse();

    const accordions = sortedYears.map(year => {
        const list = byYear.get(year);
        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">Lulusan ${escapeHtml(year)} (${list.length} orang tua)</summary>
                <table class="table" style="margin-top:4px">
                    <thead><tr><th>Nama</th><th>NIK</th><th>Anak</th></tr></thead>
                    <tbody>${list.map(p => `
                        <tr>
                            <td>${escapeHtml(p.full_name)}</td>
                            <td>${escapeHtml(p.login_identifier)}</td>
                            <td>${p.children.map(c => escapeHtml(c.full_name)).join(', ')}</td>
                        </tr>
                    `).join('')}</tbody>
                </table>
            </details>`;
    }).join('');

    parentEl.insertAdjacentHTML('beforeend', `
        <hr style="margin:24px 0;border:none;border-top:1px solid var(--color-border)" />
        <h4 style="margin:0 0 8px">Orang Tua Alumni (${alumniParents.length})</h4>
        <p class="hint" style="margin-bottom:12px">Orang tua yang semua anaknya sudah lulus, dikelompokkan per tahun kelulusan terakhir.</p>
        ${accordions}
    `);
}

// ── Alumni Section (siswa LULUS) ─────────────────────────────

async function renderAlumniSection(parentEl) {
    const data = await fetchAllRows('students',
        q => q.select(`student_id, full_name, nis, graduated_academic_year,
            program:programs ( name )
        `).eq('student_status', 'LULUS')
          .order('full_name'));

    if (data.length === 0) return;

    const byYear = new Map();
    for (const s of data) {
        const year = s.graduated_academic_year ?? 'Tidak diketahui';
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push(s);
    }

    const sortedYears = [...byYear.keys()].sort().reverse();
    const accordions = sortedYears.map(year => {
        const students = byYear.get(year);
        const byProgram = new Map();
        for (const s of students) {
            const prog = s.program?.name ?? 'Tanpa program';
            if (!byProgram.has(prog)) byProgram.set(prog, []);
            byProgram.get(prog).push(s);
        }

        const programSections = [...byProgram.entries()]
            .sort(([a], [b]) => a.localeCompare(b, 'id'))
            .map(([prog, list]) => `
                <details class="wz-accordion wz-accordion-inner">
                    <summary class="wz-accordion-header">${escapeHtml(prog)} (${list.length})</summary>
                    <table class="table" style="margin-top:4px">
                        <thead><tr><th>Nama</th><th>NIS</th></tr></thead>
                        <tbody>${list.map(s => `<tr><td>${escapeHtml(s.full_name)}</td><td>${escapeHtml(s.nis ?? '—')}</td></tr>`).join('')}</tbody>
                    </table>
                </details>
            `).join('');

        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">Lulusan ${escapeHtml(year)} (${students.length})</summary>
                <div style="padding:4px 0">${programSections}</div>
            </details>`;
    }).join('');

    parentEl.insertAdjacentHTML('beforeend', `
        <hr style="margin:24px 0;border:none;border-top:1px solid var(--color-border)" />
        <h4 style="margin:0 0 8px">Alumni (${data.length})</h4>
        <p class="hint" style="margin-bottom:12px">Siswa yang sudah lulus, dikelompokkan per tahun kelulusan.</p>
        ${accordions}
    `);
}

/** Muat ulang & render daftar data terkini untuk langkah aktif. */
async function refreshDataList(step) {
    const el = contentEl.querySelector('#wz-data-list');
    if (!el) return;
    const cfg = STEP_LIST[step];
    if (!cfg) { el.innerHTML = ''; return; }

    el.innerHTML = '<p class="hint">Memuat data…</p>';
    try {
        const rows = await cfg.fetch();
        el.innerHTML = renderDataTable(cfg, rows);
        wireDataTable(step, cfg);
        if (cfg.afterRender) await cfg.afterRender(el);
    } catch (err) {
        el.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message ?? 'Gagal memuat data.')}</div>`;
    }
}

function renderDataTable(cfg, rows) {
    const heading = `<h4 style="margin:0 0 8px">${escapeHtml(cfg.title)} (${rows.length})</h4>`;
    if (!rows.length) {
        const hint = cfg.emptyHint ?? 'Unduh template dan unggah file untuk menambahkan.';
        return heading + `<p class="hint">Belum ada data. ${hint}</p>`;
    }

    const canDelete = !!cfg.deleteTable;
    const toolbar = canDelete ? `
        <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap">
            <button type="button" class="btn btn-danger wz-del-selected" disabled>Hapus Terpilih (0)</button>
            <button type="button" class="btn btn-secondary wz-del-all">Hapus Semua (${rows.length})</button>
        </div>` : '';

    const allIdsJson = canDelete ? `<script type="application/json" class="wz-all-ids">${JSON.stringify(rows.map(r => r.id))}</script>` : '';

    if (cfg.nestedGroup) {
        return heading + toolbar + renderNestedAccordion(cfg, rows) + allIdsJson;
    }

    if (cfg.groupBy) {
        return heading + toolbar + renderGroupedAccordion(cfg, rows) + allIdsJson;
    }

    const hasEdit = !!cfg.editFields;
    const checkTh = canDelete
        ? '<th style="width:36px"><input type="checkbox" class="wz-check-all" title="Pilih semua" /></th>'
        : '';
    const editTh = hasEdit ? '<th style="width:40px"></th>' : '';
    const head = checkTh + cfg.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + editTh;

    const MAX_DISPLAY = 100;
    const displayRows = rows.slice(0, MAX_DISPLAY);
    const body = displayRows.map(r => renderRow(r, canDelete, hasEdit)).join('');

    const truncNote = rows.length > MAX_DISPLAY
        ? `<p class="hint" style="margin-top:8px">Menampilkan ${MAX_DISPLAY} dari ${rows.length} data. Hapus Semua tetap menghapus seluruh ${rows.length} data.</p>`
        : '';

    return heading + toolbar +
        `<table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` + truncNote + allIdsJson;
}

function renderRow(r, canDelete, hasEdit) {
    const checkTd = canDelete
        ? `<td><input type="checkbox" class="wz-check" value="${escapeAttr(r.id)}" /></td>`
        : '';
    const cells = r.cells.map(c => `<td>${escapeHtml(String(c ?? ''))}</td>`).join('');
    const editTd = hasEdit
        ? `<td><button type="button" class="btn btn-sm btn-secondary wz-edit-btn" data-id="${escapeAttr(r.id)}" data-edit='${escapeAttr(JSON.stringify(r.editData ?? {}))}'>✎</button></td>`
        : '';
    return `<tr>${checkTd}${cells}${editTd}</tr>`;
}

function renderGroupedAccordion(cfg, rows) {
    const canDelete = !!cfg.deleteTable;
    const hasEdit = !!cfg.editFields;
    const groups = new Map();
    for (const r of rows) {
        const key = r[cfg.groupBy] ?? '—';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    const checkTh = canDelete
        ? '<th style="width:36px"><input type="checkbox" class="wz-group-check-all" title="Pilih semua" /></th>'
        : '';
    const editTh = hasEdit ? '<th style="width:40px"></th>' : '';
    const head = checkTh + cfg.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + editTh;

    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'id'));
    return sortedKeys.map(key => {
        const groupRows = groups.get(key);
        const body = groupRows.map(r => renderRow(r, canDelete, hasEdit)).join('');
        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">${escapeHtml(key)} (${groupRows.length})</summary>
                <table class="table" style="margin-top:4px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
            </details>`;
    }).join('');
}

function renderNestedAccordion(cfg, rows) {
    const canDelete = !!cfg.deleteTable;
    const hasEdit = !!cfg.editFields;

    // Level 1: program, Level 2: kelas
    const programs = new Map();
    for (const r of rows) {
        const prog = r.program ?? '—';
        const kls  = r.kelas ?? '—';
        if (!programs.has(prog)) programs.set(prog, new Map());
        const classes = programs.get(prog);
        if (!classes.has(kls)) classes.set(kls, []);
        classes.get(kls).push(r);
    }

    const checkTh = canDelete
        ? '<th style="width:36px"><input type="checkbox" class="wz-group-check-all" title="Pilih semua di kelas ini" /></th>'
        : '';
    const editTh = hasEdit ? '<th style="width:40px"></th>' : '';
    const head = checkTh + cfg.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + editTh;

    const sortedProgs = [...programs.keys()].sort((a, b) => a.localeCompare(b, 'id'));
    return sortedProgs.map(prog => {
        const classMap = programs.get(prog);
        let progTotal = 0;
        classMap.forEach(arr => { progTotal += arr.length; });

        const sortedClasses = [...classMap.keys()].sort((a, b) => a.localeCompare(b, 'id'));
        const classAccordions = sortedClasses.map(kls => {
            const classRows = classMap.get(kls);
            const body = classRows.map(r => renderRow(r, canDelete, hasEdit)).join('');
            return `
                <details class="wz-accordion wz-accordion-inner">
                    <summary class="wz-accordion-header">${escapeHtml(kls)} (${classRows.length})</summary>
                    <table class="table" style="margin-top:4px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
                </details>`;
        }).join('');

        return `
            <details class="wz-accordion">
                <summary class="wz-accordion-header">${escapeHtml(prog)} (${progTotal})</summary>
                <div style="padding:4px 0">${classAccordions}</div>
            </details>`;
    }).join('');
}

function wireDataTable(step, cfg) {
    if (!cfg.deleteTable) return;

    const checks   = Array.from(contentEl.querySelectorAll('.wz-check'));
    const checkAll = contentEl.querySelector('.wz-check-all');
    const selBtn   = contentEl.querySelector('.wz-del-selected');
    const allBtn   = contentEl.querySelector('.wz-del-all');

    // Tabel kosong (tanpa toolbar/checkbox) — tidak ada yang perlu di-wire.
    if (!selBtn || !allBtn) return;

    const selectedIds = () => checks.filter(c => c.checked).map(c => c.value);

    function syncSelectedBtn() {
        const n = selectedIds().length;
        selBtn.textContent = `Hapus Terpilih (${n})`;
        selBtn.disabled = n === 0;
        if (checkAll) checkAll.checked = n > 0 && n === checks.length;
    }

    checks.forEach(c => c.addEventListener('change', syncSelectedBtn));
    if (checkAll) {
        checkAll.addEventListener('change', () => {
            checks.forEach(c => { c.checked = checkAll.checked; });
            syncSelectedBtn();
        });
    }

    // Per-group "check all" di accordion
    contentEl.querySelectorAll('.wz-group-check-all').forEach(groupCheckAll => {
        const groupChecks = Array.from(
            groupCheckAll.closest('table').querySelectorAll('.wz-check')
        );
        groupCheckAll.addEventListener('change', () => {
            groupChecks.forEach(c => { c.checked = groupCheckAll.checked; });
            syncSelectedBtn();
        });
    });

    selBtn.addEventListener('click', async () => {
        const ids = selectedIds();
        if (!ids.length) return;
        if (SERVER_RESET_STEPS.has(step)) {
            if (!confirm(`Hapus ${ids.length} data terpilih? Tindakan ini tidak dapat dibatalkan.`)) return;
            runServerReset(step, ids, selBtn);
            return;
        }
        const blockMsg = await checkDeleteOrder(step, ids);
        if (blockMsg) { showError(blockMsg); return; }
        if (!confirm(`Hapus ${ids.length} data terpilih? Tindakan ini tidak dapat dibatalkan.`)) return;
        runBulkDelete(step, cfg, ids, selBtn);
    });

    allBtn.addEventListener('click', async () => {
        const allIdsEl = contentEl.querySelector('.wz-all-ids');
        const ids = allIdsEl ? JSON.parse(allIdsEl.textContent) : checks.map(c => c.value);
        if (!ids.length) return;
        if (SERVER_RESET_STEPS.has(step)) {
            if (!confirm(`Hapus SEMUA ${ids.length} data pada langkah ini? Tindakan ini tidak dapat dibatalkan.`)) return;
            runServerReset(step, ids, allBtn);
            return;
        }
        const blockMsg = await checkDeleteOrder(step, ids);
        if (blockMsg) { showError(blockMsg); return; }
        if (!confirm(`Hapus SEMUA ${ids.length} data pada langkah ini? Tindakan ini tidak dapat dibatalkan.`)) return;
        runBulkDelete(step, cfg, ids, allBtn);
    });

    // Wire edit buttons
    if (cfg.editFields) {
        contentEl.querySelectorAll('.wz-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const editData = JSON.parse(btn.dataset.edit || '{}');
                showEditModal(step, cfg, id, editData);
            });
        });
    }
}

function showEditModal(step, cfg, id, editData) {
    let existing = document.getElementById('wz-edit-modal');
    if (existing) existing.remove();

    const fields = cfg.editFields.map(f => `
        <div class="field">
            <label>${escapeHtml(f.label)}</label>
            <input type="text" class="input wz-edit-field" data-key="${escapeAttr(f.key)}"
                value="${escapeAttr(editData[f.key] ?? '')}" />
        </div>
    `).join('');

    const modal = document.createElement('div');
    modal.id = 'wz-edit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:999';
    modal.innerHTML = `
        <div style="background:var(--color-surface);border-radius:var(--radius-lg);padding:24px;width:100%;max-width:440px;box-shadow:var(--shadow-md)">
            <h4 style="margin:0 0 16px">Edit Data</h4>
            <div id="wz-edit-error" class="alert alert-danger" style="display:none"></div>
            ${fields}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
                <button type="button" class="btn btn-secondary" id="wz-edit-cancel">Batal</button>
                <button type="button" class="btn btn-primary" id="wz-edit-save">Simpan</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('wz-edit-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById('wz-edit-save').addEventListener('click', async () => {
        const saveBtn = document.getElementById('wz-edit-save');
        const errEl   = document.getElementById('wz-edit-error');
        errEl.style.display = 'none';

        const vals = {};
        modal.querySelectorAll('.wz-edit-field').forEach(input => {
            vals[input.dataset.key] = input.value.trim();
        });

        const empty = cfg.editFields.filter(f => !vals[f.key]);
        if (empty.length) {
            errEl.textContent = `Field wajib kosong: ${empty.map(f => f.label).join(', ')}`;
            errEl.style.display = 'block';
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Menyimpan...';
        try {
            const result = await cfg.save(id, vals, editData);
            modal.remove();

            // Tampilkan info kelas yang ikut di-rename
            if (Array.isArray(result) && result.length > 0) {
                const renameList = result.map(r => `${r.from} → ${r.to}`).join(', ');
                showSuccess(`Data diperbarui. Kelas ikut di-rename: ${renameList}`);
            }

            await refreshDataList(step);
        } catch (err) {
            errEl.textContent = err.message ?? 'Gagal menyimpan perubahan.';
            errEl.style.display = 'block';
            saveBtn.disabled = false;
            saveBtn.textContent = 'Simpan';
        }
    });
}

// Validasi urutan hapus: cek tabel yang mereferensi data pada langkah ini.
// Byproduct impor (class_enrollments, student_parents, teaching_assignments,
// schedule_templates) di-cascade otomatis — tidak perlu dicek di sini.
// Yang dicek: data transaksional/operasional yang harus dihapus manual.
const DELETE_ORDER_CHECKS = {
    3: [ // Program: kelas & siswa harus kosong dulu (filter by program_id)
        { label: 'Kelas (langkah 4)',  table: 'classes',  query: (q, ids) => q.select('class_id', { count: 'exact', head: true }).in('program_id', ids) },
        { label: 'Siswa (langkah 6)',  table: 'students', query: (q, ids) => q.select('student_id', { count: 'exact', head: true }).in('program_id', ids) },
    ],
    4: [ // Kelas: jadwal & siswa harus kosong
        { label: 'Jadwal (langkah 10)', table: 'teaching_schedules', query: q => q.select('schedule_id', { count: 'exact', head: true }) },
        { label: 'Siswa (langkah 6)',   table: 'students', query: q => q.select('student_id', { count: 'exact', head: true }) },
    ],
    5: [ // Staf: jadwal harus kosong
        { label: 'Jadwal (langkah 10)', table: 'teaching_schedules', query: q => q.select('schedule_id', { count: 'exact', head: true }) },
        { label: 'Guru pengganti',      table: 'substitute_schedules', query: q => q.select('substitute_id', { count: 'exact', head: true }) },
    ],
    6: [ // Siswa: data transaksional harus kosong (enrollment & student_parents di-cascade)
        { label: 'Kehadiran',   table: 'attendance',    query: q => q.select('attendance_id', { count: 'exact', head: true }) },
        { label: 'Observasi',   table: 'observations',  query: q => q.select('observation_id', { count: 'exact', head: true }) },
        { label: 'Kasus',       table: 'cases',         query: q => q.select('case_id', { count: 'exact', head: true }) },
    ],
    10: [ // Jadwal: data transaksional harus kosong
        { label: 'Kehadiran',       table: 'attendance',           query: q => q.select('attendance_id', { count: 'exact', head: true }) },
        { label: 'Observasi',       table: 'observations',         query: q => q.select('observation_id', { count: 'exact', head: true }).not('schedule_id', 'is', null) },
        { label: 'Guru pengganti',  table: 'substitute_schedules', query: q => q.select('substitute_id', { count: 'exact', head: true }) },
    ],
};

async function checkDeleteOrder(step, ids = []) {
    const checks = DELETE_ORDER_CHECKS[step];
    if (!checks) return null;

    const results = await Promise.all(
        checks.map(c => c.query(supabase.from(c.table), ids))
    );

    const blockers = [];
    results.forEach(({ count, error }, i) => {
        if (error) {
            console.warn(`[checkDeleteOrder] ${checks[i].table}:`, error.message);
            return;
        }
        if (count > 0) blockers.push(`${checks[i].label} (${count})`);
    });

    if (blockers.length === 0) return null;
    return `Tidak bisa menghapus — masih ada data terkait: ${blockers.join(', ')}. Hapus data tersebut terlebih dahulu.`;
}

async function runBulkDelete(step, cfg, ids, btn) {
    clearError();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = `Menghapus 0/${ids.length}…`;
    const onProgress = (done, total) => { btn.textContent = `Menghapus ${done}/${total}…`; };
    try {
        const { deleted, errors } = await deleteBulk(cfg.deleteTable, ids, onProgress);
        if (errors.length) {
            showError(`${deleted} terhapus, ${errors.length} gagal. Contoh: ${errors[0].message}`);
        }
    } catch (err) {
        showError(err.message ?? 'Gagal menghapus data.');
    } finally {
        btn.textContent = label;
        await refreshDataList(step);
    }
}

// Step 6 (siswa) dan step 10 (jadwal) tidak bisa dihapus via RLS client-side
// karena attendance tidak punya policy DELETE untuk ADMINISTRATIVE (ABS-3) dan
// guru_wali_assignments hanya bisa dihapus oleh KEPSEK/WAKA.
// Keduanya diarahkan ke SECURITY DEFINER function di server.
const SERVER_RESET_STEPS = new Set([6, 10]);

async function runServerReset(step, ids, btn) {
    clearError();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Menghapus…';
    try {
        const config = await getSchoolConfig();
        const schoolId = config?.school_id;
        if (!schoolId) throw new Error('school_id tidak ditemukan.');

        if (step === 6) {
            btn.textContent = 'Menghapus siswa & data terkait…';
            const result = await wizardResetStudents(schoolId, ids);
            // Hapus akun auth siswa via edge function (satu per satu, tidak blocking UI)
            const authIds = result?.auth_user_ids ?? [];
            if (authIds.length > 0) {
                btn.textContent = `Menghapus ${authIds.length} akun…`;
                await Promise.allSettled(authIds.map(aid => deleteUserWithAuth(aid)));
            }
        } else if (step === 10) {
            btn.textContent = 'Menghapus jadwal & data terkait…';
            await wizardResetSchedules(schoolId);
        }
    } catch (err) {
        showError(err.message ?? 'Gagal menghapus data.');
    } finally {
        btn.textContent = label;
        btn.disabled = false;
        await refreshDataList(step);
    }
}

// ─────────────────────────────────────────────────────────────
// INIT (auth guard + render langkah 1)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// GANTI PASSWORD (modal)
// ─────────────────────────────────────────────────────────────

function showPasswordModal(isFirstTime) {
    const modal      = document.getElementById('password-modal');
    const newPassEl  = document.getElementById('modal-new-password');
    const confirmEl  = document.getElementById('modal-confirm-password');
    const submitBtn  = document.getElementById('modal-submit-btn');
    const modalErrEl = document.getElementById('password-modal-error');

    newPassEl.value  = '';
    confirmEl.value  = '';
    modalErrEl.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Simpan Password';
    modal.style.display = 'flex';

    const handler = async () => {
        const newPass     = newPassEl.value;
        const confirmPass = confirmEl.value;

        modalErrEl.style.display = 'none';
        modalErrEl.textContent = '';

        if (newPass.length < 8) {
            modalErrEl.textContent = 'Password minimal 8 karakter.';
            modalErrEl.style.display = 'block';
            return;
        }
        if (newPass === 'Admin1234') {
            modalErrEl.textContent = 'Password tidak boleh sama dengan password default.';
            modalErrEl.style.display = 'block';
            return;
        }
        if (newPass !== confirmPass) {
            modalErrEl.textContent = 'Konfirmasi password tidak cocok.';
            modalErrEl.style.display = 'block';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Menyimpan...';

        try {
            await changePassword(newPass);
            modal.style.display = 'none';
            if (isFirstTime) await goToStep(1);
        } catch (err) {
            modalErrEl.textContent = err.message ?? 'Gagal menyimpan password. Coba lagi.';
            modalErrEl.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Simpan Password';
        }
    };

    // Assign (not add) so re-opening the modal replaces the old handler instead of stacking
    submitBtn.onclick = handler;
}

// Guard: peringatan saat TU menutup/refresh halaman di tengah wizard
let importRunning = false;
window.addEventListener('beforeunload', (e) => {
    if (importRunning) {
        e.preventDefault();
        e.returnValue = '';
    }
});

(async function init() {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) { window.location.replace('index.html'); return; }

    const userRow = await getCurrentUserRow();
    if (!requireAdministrativeOrRedirect(userRow)) return;
    state.schoolId = userRow.school_id;

    // Paksa ganti password jika di-reset superadmin (must_change_password)
    // — dicek di sini juga agar berlaku saat wizard dibuka langsung (bookmark).
    await checkMustChangePassword(supabase, userRow);

    // Tombol logout di header — di-wire lebih awal agar tetap berfungsi
    // bahkan saat wizard terblokir oleh modal ganti password.
    const logoutBtn = document.getElementById('wizard-logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            logoutBtn.disabled = true;
            logoutBtn.textContent = 'Keluar...';
            try {
                await logout();
            } catch (_) {
                // signOut gagal pun session lokal tetap dihapus oleh Supabase client
            } finally {
                window.location.replace('index.html');
            }
        });
    }

    // Tombol ganti password di header — selalu tersedia
    const changePwBtn = document.getElementById('wizard-change-pw-btn');
    if (changePwBtn) {
        changePwBtn.addEventListener('click', () => showPasswordModal(false));
    }

    // Hamburger: buka/tutup sidebar drawer di mobile
    const menuBtn      = document.getElementById('wizard-menu-btn');
    const sidebar      = document.querySelector('.wz-sidebar');
    const backdrop     = document.getElementById('wizard-sidebar-backdrop');
    function openSidebar()  { sidebar.classList.add('open'); backdrop.style.display = 'block'; }
    function closeSidebar() { sidebar.classList.remove('open'); backdrop.style.display = 'none'; }
    if (menuBtn)  menuBtn.addEventListener('click', openSidebar);
    if (backdrop) backdrop.addEventListener('click', closeSidebar);
    // Tutup drawer saat klik item langkah di sidebar
    document.getElementById('wizard-steps')?.addEventListener('click', () => closeSidebar());

    // Cek apakah password default sudah diganti
    let config = null;
    let configLoadFailed = false;
    try { config = await getSchoolConfig(); } catch (_) { configLoadFailed = true; }

    if (configLoadFailed) {
        contentEl.innerHTML = `<div class="alert alert-danger" style="margin-top:2rem">
            <strong>Gagal memuat konfigurasi sekolah.</strong><br>
            Periksa koneksi internet Anda lalu
            <a href="" style="color:inherit;text-decoration:underline">muat ulang halaman</a>.
        </div>`;
        return;
    }

    if (!config?.password_changed) {
        showPasswordModal(true);
        return;
    }

    const hashStep = parseInt(location.hash.slice(1), 10);
    await goToStep((hashStep >= 1 && hashStep <= TOTAL_STEPS) ? hashStep : 1);
})();
