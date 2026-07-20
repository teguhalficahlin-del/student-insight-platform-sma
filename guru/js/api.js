/**
 * @file guru/js/api.js
 * Supabase wrapper untuk Portal Guru (semua peran staf sekolah).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { saveObservation, saveJournalEntry, saveCase } from './offline.js';

// Diekspor agar offline.js dapat memakainya di postEdgeFn tanpa membuat
// client Supabase duplikat (regresi 6ded3e5: konstanta ini pernah terhapus
// bersama client duplikat, membuat postEdgeFn lempar ReferenceError → semua
// submit edge-function guru gagal senyap dan mengantre selamanya).
export const SUPABASE_URL      = 'https://dfugplddogrbzrwxifdf.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_A5QPhZVwzmAQKGtKB49sHQ_loIkEug-';

try {
    const _mk = 'sb-dfugplddogrbzrwxifdf-auth-token';
    const _lv = localStorage.getItem(_mk);
    if (_lv && !sessionStorage.getItem(_mk)) { sessionStorage.setItem(_mk, _lv); localStorage.removeItem(_mk); }
} catch { /* private mode */ }

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: true, storage: sessionStorage },
});

// Semua role_type yang boleh masuk portal ini
export const GURU_ROLES = ['GURU','WALI_KELAS','BK','KEPSEK','WAKA_KURIKULUM','WAKA_KESISWAAN'];

export async function loginWithIdentifier(identifier, password, schoolId = null) {
    const { data: email, error: resolveErr } = await supabase
        .rpc('fn_resolve_login_email', { p_identifier: identifier, p_school_id: schoolId });
    if (resolveErr) throw new Error('Gagal menghubungi server. Coba lagi.');
    if (!email) throw new Error('NIP/NIK tidak ditemukan di sekolah ini. Hubungi admin untuk memastikan akun sudah dibuat.');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        if (error.status === 429 || /rate limit|too many/i.test(error.message || ''))
            throw new Error('Terlalu banyak percobaan login. Tunggu ±15 menit lalu coba lagi.');
        throw new Error('Password salah. Jika baru pertama login, gunakan password default dari admin.');
    }
}

export async function logout() {
    await supabase.auth.signOut();
}

// ── Peringatan login dari perangkat baru (Item 5, Opsi A) ─────
// Menghitung "sidik jari" perangkat stabil (id acak persisten di
// localStorage + userAgent) lalu mendaftarkannya lewat RPC. Bila
// perangkat belum pernah dipakai (dan bukan yang pertama), server
// menaruh notifikasi "Login dari perangkat baru" di lonceng.
// Non-blocking & fail-safe: kegagalan tidak pernah menghalangi login.
function parseDeviceLabel(ua) {
    ua = ua || '';
    let browser = 'Browser';
    if (/Edg\//.test(ua))            browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua))    browser = 'Chrome';
    else if (/Firefox\//.test(ua))   browser = 'Firefox';
    else if (/Safari\//.test(ua))    browser = 'Safari';
    let os = 'perangkat';
    if (/Windows/.test(ua))                 os = 'Windows';
    else if (/Android/.test(ua))            os = 'Android';
    else if (/iPhone|iPad|iOS/.test(ua))    os = 'iOS';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua))              os = 'Linux';
    return `${browser} di ${os}`;
}

export async function registerLoginDevice() {
    try {
        let devId = localStorage.getItem('sip_device_id');
        if (!devId) { devId = crypto.randomUUID(); localStorage.setItem('sip_device_id', devId); }
        const ua  = navigator.userAgent || '';
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(devId + '|' + ua));
        const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        const { data, error } = await supabase.rpc('fn_register_login_device', {
            p_device_hash: hash,
            p_user_agent:  ua.slice(0, 400),
            p_label:       parseDeviceLabel(ua),
        });
        if (error) { console.warn('[login-device]', error.message); return null; }
        return data; // 'known' | 'first' | 'new'
    } catch (e) {
        console.warn('[login-device]', e);
        return null;
    }
}

export async function getCurrentUserRow(authUser = null) {
    const user = authUser ?? (await supabase.auth.getUser()).data?.user;
    if (!user) return null;
    const { data, error } = await supabase
        .from('users')
        .select(`
            user_id, school_id, full_name, role_type, login_identifier, teacher_code,
            wali_kelas_class_id,
            is_bk, is_kepsek, is_waka_kurikulum, is_waka_kesiswaan, is_waka_humas, is_active,
            must_change_password, last_seen_at, last_seen_ua,
            teaching_assignments(count)
        `)
        .eq('auth_user_id', user.id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/**
 * Kembalikan daftar jabatan aktif user berdasarkan role_type + flag tambahan.
 * Dipakai untuk menentukan tab mana yang muncul di dashboard.
 */
export function getJabatan(u) {
    if (!u) return [];
    const j = [];
    if (u.role_type === 'WALI_KELAS' || u.wali_kelas_class_id) j.push('wali_kelas');
    if (u.role_type === 'BK'         || u.is_bk)               j.push('bk');
    if (u.role_type === 'WAKA_KESISWAAN' || u.is_waka_kesiswaan) j.push('waka_kesiswaan');
    if (u.role_type === 'WAKA_KURIKULUM' || u.is_waka_kurikulum) j.push('waka_kurikulum');
    if (u.role_type === 'WAKA_HUMAS'     || u.is_waka_humas)    j.push('waka_humas');
    if (u.role_type === 'KEPSEK'     || u.is_kepsek)            j.push('kepsek');
    return j;
}

export function jabatanLabel(key) {
    return {
        wali_kelas:    'Wali Kelas',
        bk:            'BK',
        waka_kesiswaan:'Waka Kesiswaan',
        waka_kurikulum:'Waka Kurikulum',
        waka_humas:    'Waka Humas',
        kepsek:        'Kepala Sekolah',
    }[key] ?? key;
}

// ─── JADWAL GURU ────────────────────────────────────────────

export async function getSchoolConfig() {
    const { data } = await supabase.from('school_config').select('current_academic_year, current_semester').single();
    return data;
}

/**
 * Jadwal mengajar guru pada tanggal tertentu.
 * Filter langsung via scheduled_teacher_id (tidak perlu join ke assignments).
 */
export async function getMyScheduleForDate(userId, date) {
    const { data, error } = await supabase
        .from('teaching_schedules')
        .select(`
            schedule_id, session_date, session_start, session_end,
            class:classes ( class_id, name )
        `)
        .eq('session_date', date)
        .eq('scheduled_teacher_id', userId)
        .order('session_start');
    if (error) throw error;
    return data ?? [];
}

/**
 * Kelas unik yang diampu guru ini pada tahun ajaran + semester tertentu.
 * Dipakai untuk dropdown rekap absensi guru.
 */
export async function getMyClasses(userId, academicYear, semester) {
    const { data, error } = await supabase
        .from('teaching_assignments')
        .select('class:classes ( class_id, name )')
        .eq('user_id', userId)
        .eq('academic_year', academicYear)
        .eq('semester', semester)
        .eq('is_active', true);
    if (error) throw error;
    const seen = new Set();
    const classes = [];
    for (const ta of data ?? []) {
        const c = ta.class;
        if (c && !seen.has(c.class_id)) {
            seen.add(c.class_id);
            classes.push(c);
        }
    }
    return classes.sort((a, b) => a.name.localeCompare(b.name, 'id'));
}


// ─── SISWA & KEHADIRAN ───────────────────────────────────────

/**
 * Daftar siswa aktif di suatu kelas (via class_enrollments, tidak withdrawn).
 */
export async function getEnrolledStudents(classId, academicYear) {
    const { data, error } = await supabase
        .from('class_enrollments')
        .select('student:students ( student_id, nis, full_name, student_status )')
        .eq('class_id', classId)
        .eq('academic_year', academicYear)
        .is('withdrawn_at', null);
    if (error) throw error;
    // DROPOUT-1 (Tema I): roster kelas hanya siswa AKTIF — siswa KELUAR/LULUS
    // tak ikut diabsen di kelas. Riwayat mereka tetap terlihat di tampilan lain;
    // ini hanya menyaring daftar absen harian.
    return (data ?? []).map(r => r.student)
        .filter(s => s && s.student_status === 'AKTIF')
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'));
}

/**
 * Kehadiran yang sudah ada untuk satu sesi jadwal.
 * Returns Map: student_id → { attendance_id, status, notes }
 */
export async function getAttendanceForSession(scheduleId) {
    const { data, error } = await supabase
        .from('attendance')
        .select('attendance_id, student_id, status, notes')
        .eq('schedule_id', scheduleId);
    if (error) throw error;
    const map = new Map();
    for (const r of data ?? []) map.set(r.student_id, r);
    return map;
}

// Catatan (ABS-5, audit absensi 2026-07-04): fungsi upsertAttendance dihapus.
// Ia menulis langsung ke tabel attendance tanpa validasi enrolmen (yang hanya
// ada di jalur edge sync-attendance-batch) dan sudah tidak dipakai — semua
// penyimpanan absensi lewat saveAttendanceBatch → edge. Jangan hidupkan kembali
// jalur tulis langsung tanpa validasi siswa-terdaftar setara jalur edge.

// ─── OBSERVASI ───────────────────────────────────────────────

/**
 * Semua siswa di kelas-kelas yang diajar guru ini (untuk selector observasi).
 * Ambil via teaching_assignments aktif periode berjalan.
 */
export async function getMyStudents(userId, academicYear, semester) {
    const { data, error } = await supabase
        .from('teaching_assignments')
        .select('class:classes ( class_id, name, enrollments:class_enrollments ( student:students ( student_id, nis, full_name ) ) )')
        .eq('user_id', userId)
        .eq('academic_year', academicYear)
        .eq('semester', semester)
        .eq('is_active', true);
    if (error) throw error;

    const seen = new Set();
    const students = [];
    for (const ta of data ?? []) {
        for (const en of ta.class?.enrollments ?? []) {
            const s = en.student;
            if (s && !seen.has(s.student_id)) {
                seen.add(s.student_id);
                students.push({ ...s, class_id: ta.class?.class_id, class_name: ta.class?.name });
            }
        }
    }
    return students.sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'));
}

/**
 * Pencarian siswa sisi-server untuk observer berjangkauan luas
 * (BK / Waka Kesiswaan / Kepsek) yang mungkin tidak mengajar
 * sehingga getMyStudents (berbasis teaching_assignments) kosong.
 * Cakupan hasil dibatasi RLS sesuai peran pemanggil.
 */
export async function searchStudents(query, schoolId) {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];
    const term = `%${q}%`;
    let req = supabase
        .from('students')
        .select('student_id, nis, full_name, student_status, class_enrollments(classes(name))')
        .or(`full_name.ilike.${term},nis.ilike.${term}`)
        .in('student_status', ['AKTIF'])
        .order('full_name')
        .limit(15);
    if (schoolId) req = req.eq('school_id', schoolId);
    const { data, error } = await req;
    if (error) throw error;
    return (data ?? []).map(s => ({
        ...s,
        class_name: s.class_enrollments?.[0]?.classes?.name ?? '',
    }));
}

/**
 * Simpan observasi baru. Offline-capable: antre ke IndexedDB bila jaringan mati.
 * @returns {{status:'synced'|'queued'|'error', error?:string}}
 */
export async function insertObservation({ obsId, authorId, studentId, dimension, sentiment, visibility, content }) {
    const observation_id = obsId ?? crypto.randomUUID();
    const payload = {
        idempotency_key: crypto.randomUUID(),
        observation_id,
        author_user_id:  authorId,
        student_id:      studentId,
        dimension,
        sentiment,
        visibility,
        content,
        observed_at:     new Date().toISOString().slice(0, 10),
    };
    const result = await saveObservation(payload);
    return { ...result, observation_id };
}

// ─── WALI KELAS ──────────────────────────────────────────────

export async function getWaliKelasInfo(classId) {
    if (!classId) return null;
    const { data } = await supabase
        .from('classes')
        .select('class_id, name, grade_level')
        .eq('class_id', classId)
        .maybeSingle();
    return data;
}

/**
 * Rekap kehadiran per siswa di kelas wali kelas (untuk dashboard wali).
 * Returns [{ student_id, full_name, nis, HADIR, ALPA, IZIN, SAKIT, total }]
 * Catatan: EKSKUL dihapus dari absensi → data lama berstatus EKSKUL dihitung HADIR.
 */
export async function getWaliAttendanceSummary(classId, academicYear, dateStart, dateEnd) {
    const { data, error } = await supabase.rpc('fn_class_attendance_summary', {
        p_class_id:      classId,
        p_academic_year: academicYear,
        p_date_start:    dateStart ?? null,
        p_date_end:      dateEnd   ?? null,
        p_teacher_id:    null,
    });
    if (error) throw error;
    return (data ?? []).map(r => ({
        student_id:  r.student_id,
        full_name:   r.full_name,
        nis:         r.nis,
        HADIR:       Number(r.hadir),
        ALPA:        Number(r.alpa),
        IZIN:        Number(r.izin),
        SAKIT:       Number(r.sakit),
        total:       Number(r.total),
    }));
}

export async function getProgram(programId) {
    if (!programId) return null;
    const { data, error } = await supabase.from('programs').select('program_id, code, name').eq('program_id', programId).maybeSingle();
    if (error) throw error;
    return data;
}

export async function getPrograms() {
    const { data, error } = await supabase
        .from('programs')
        .select('program_id, name')
        .eq('is_active', true)
        .order('name');
    if (error) throw error;
    return data ?? [];
}

export async function getStudentAttendanceSessions(studentId, dateStart, dateEnd, teacherId = null) {
    if (!dateStart || !dateEnd) {
        return [];
    }
    let q = supabase
        .from('attendance')
        .select(`
            attendance_id, status, is_void,
            schedule:teaching_schedules!inner (
                session_date, session_start, session_end,
                subject:subjects ( name ),
                teacher:users ( full_name )
            )
        `)
        .eq('student_id', studentId)
        .eq('is_void', false)
        .order('created_at', { ascending: false });
    if (dateStart)  q = q.gte('teaching_schedules.session_date', dateStart);
    if (dateEnd)    q = q.lte('teaching_schedules.session_date', dateEnd);
    if (teacherId)  q = q.eq('teaching_schedules.scheduled_teacher_id', teacherId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? [])
        .filter(r => r.schedule)
        .sort((a, b) => (b.schedule.session_date ?? '').localeCompare(a.schedule.session_date ?? ''));
}


// ─── KEPSEK / WAKA ──────────────────────────────────────────

export async function getSchoolStats(academicYear, semester) {
    const today = new Date().toISOString().slice(0, 10);
    const [studentsRes, staffRes, schedToday, attToday] = await Promise.all([
        supabase.from('students').select('student_id', { count: 'exact', head: true }).eq('student_status', 'AKTIF'),
        supabase.from('v_users_staff_directory').select('user_id', { count: 'exact', head: true }).not('role_type', 'in', '("SISWA","ORTU","DUDI","ADMINISTRATIVE","STAKEHOLDER")'),
        supabase.from('teaching_schedules').select('schedule_id, class_id', { count: 'exact' }).eq('session_date', today).eq('academic_year', academicYear),
        supabase.from('attendance').select('status', { count: 'exact' }).gte('created_at', today + 'T00:00:00').eq('status', 'HADIR'),
    ]);
    return {
        total_siswa:       studentsRes.count ?? 0,
        total_staf:        staffRes.count ?? 0,
        sesi_hari_ini:     schedToday.count ?? 0,
        kehadiran_hari_ini: attToday.count ?? 0,
    };
}

export async function getKepsekMonitoring(period = 'hari_ini', academicYear = null, dateStart = null, dateEnd = null) {
    const { data, error } = await supabase.rpc('fn_kepsek_monitoring', {
        p_period:        period,
        p_academic_year: academicYear,
        p_date_start:    dateStart,
        p_date_end:      dateEnd,
    });
    if (error) throw error;
    return data;
}

export async function getAttendanceFillRate(dateStart, dateEnd) {
    const { data, error } = await supabase.rpc('fn_attendance_fill_rate', {
        p_date_start: dateStart ?? null,
        p_date_end:   dateEnd   ?? null,
    });
    if (error) throw error;
    const rows   = data ?? [];
    const get    = key => Number(rows.find(r => r.teacher_indicator === key)?.jumlah ?? 0);
    const hadir  = get('HADIR');
    const pending = get('PENDING_EVALUATION');
    const tidak  = get('TIDAK_HADIR');
    return { total: hadir + pending + tidak, hadir, pending, tidak };
}

// Hanya untuk Panel 1 (hari ini) — satu hari, baris sedikit, aman tanpa RPC.
export async function getPendingAttendanceSessions(date) {
    const { data, error } = await supabase
        .from('teaching_schedules')
        .select('session_start, session_end, class:classes(name), teacher:users(full_name), subject:subjects(name)')
        .eq('teacher_indicator', 'PENDING_EVALUATION')
        .eq('meeting_status', 'NORMAL')
        .eq('session_date', date)
        .order('session_start', { ascending: true });
    if (error) throw error;
    return data ?? [];
}

export async function getPendingSessionsByTeacher(dateStart, dateEnd) {
    const { data, error } = await supabase.rpc('fn_pending_sessions_by_teacher', {
        p_date_start: dateStart ?? null,
        p_date_end:   dateEnd   ?? null,
    });
    if (error) throw error;
    return data ?? [];
}

export async function getPendingSessionsDetail(teacherId, dateStart, dateEnd) {
    const { data, error } = await supabase.rpc('fn_pending_sessions_detail', {
        p_teacher_id: teacherId,
        p_date_start: dateStart ?? null,
        p_date_end:   dateEnd   ?? null,
    });
    if (error) throw error;
    return data ?? [];
}

// ─── WAKA KESISWAAN ─────────────────────────────────────────

export async function getAttendanceRecapPerClass(dateStart, dateEnd) {
    const { data, error } = await supabase.rpc('fn_attendance_recap_per_class', {
        p_date_start: dateStart ?? null,
        p_date_end:   dateEnd   ?? null,
    });
    if (error) throw error;
    return (data ?? []).map(r => ({
        class_id:    r.class_id,
        name:        r.name,
        HADIR:       Number(r.hadir),
        ALPA:        Number(r.alpa),
        IZIN:        Number(r.izin),
        SAKIT:       Number(r.sakit),
        total:       Number(r.total),
    }));
}

/**
 * Daftar siswa aktif berdasarkan class_id.
 */
export async function getClassStudents(classId) {
    const { data, error } = await supabase
        .from('students')
        .select('student_id, nis, full_name')
        .eq('class_id', classId)
        .eq('is_active', true)
        .order('full_name');
    if (error) throw error;
    return data ?? [];
}

export async function getAttendanceSummaryByStudents(classId, academicYear, dateStart, dateEnd, teacherId = null) {
    const { data, error } = await supabase.rpc('fn_class_attendance_summary', {
        p_class_id:      classId,
        p_academic_year: academicYear,
        p_date_start:    dateStart ?? null,
        p_date_end:      dateEnd   ?? null,
        p_teacher_id:    teacherId ?? null,
    });
    if (error) throw error;
    return (data ?? []).map(r => ({
        student_id:  r.student_id,
        full_name:   r.full_name,
        nis:         r.nis,
        HADIR:       Number(r.hadir),
        ALPA:        Number(r.alpa),
        IZIN:        Number(r.izin),
        SAKIT:       Number(r.sakit),
        total:       Number(r.total),
    }));
}

export async function getOpenCases(schoolId) {
    let q = supabase
        .from('cases')
        .select('case_id, title, status, track, current_handler_role, created_at, student:students(full_name, nis)')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false })
        .limit(100);
    if (schoolId) q = q.eq('school_id', schoolId);
    const { data, error } = await q;
    if (error) throw error;
    return data ?? [];
}

// ─── JURNAL MENGAJAR ─────────────────────────────────────────

export async function getJournalEntries(userId) {
    const { data, error } = await supabase
        .from('teacher_journals')
        .select('journal_id, entry_date, content, created_at')
        .eq('owner_user_id', userId)
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) throw error;
    return data ?? [];
}

/**
 * Simpan entri jurnal baru. Offline-capable: antre ke IndexedDB bila jaringan mati.
 * @returns {{status:'synced'|'queued'|'error', error?:string}}
 */
export async function insertJournalEntry(userId, entryDate, content) {
    const payload = {
        idempotency_key: crypto.randomUUID(),
        journal_id:      crypto.randomUUID(),
        owner_user_id:   userId,
        entry_date:      entryDate,
        content,
    };
    const r = await saveJournalEntry(payload);
    return { ...r, journal_id: payload.journal_id };
}

export async function deleteJournalEntry(journalId) {
    const { error } = await supabase
        .from('teacher_journals')
        .delete()
        .eq('journal_id', journalId);
    if (error) throw error;
}

export async function updateJournalEntry(journalId, entryDate, content, userId) {
    // Reuse saveJournalEntry (fn_sync_journal adalah UPSERT by journal_id).
    // Dengan begitu edit jurnal ikut jalur offline-capable yang sama dengan insert.
    return saveJournalEntry({
        idempotency_key: crypto.randomUUID(),
        journal_id:      journalId,
        owner_user_id:   userId,
        entry_date:      entryDate,
        content,
    });
}

export async function getMyObservations(userId) {
    const { data, error } = await supabase
        .from('observations')
        .select(`
            observation_id, dimension, sentiment, visibility, content, observed_at, created_at,
            student_id, author_user_id, is_void, void_reason,
            student:students!observations_student_id_fkey ( full_name, nis )
        `)
        .eq('author_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);
    if (error) throw error;
    return data ?? [];
}

export async function getStudentUserId(studentId) {
    const { data } = await supabase
        .from('students')
        .select('student_id, user_id')
        .eq('student_id', studentId)
        .maybeSingle();
    return data?.user_id ?? null;
}

export async function getStudentParents(studentId) {
    const { data, error } = await supabase
        .from('student_parents')
        .select('parent_user_id, users:parent_user_id(full_name)')
        .eq('student_id', studentId);
    if (error) throw error;
    return data ?? [];
}


// ─── KASUS ───────────────────────────────────────────────────

// Diganti oleh getUnreadNotifCount — tetap diekspor untuk kompatibilitas sementara
export async function countNewCaseEvents(roleType, since) {
    const { count, error } = await supabase
        .from('case_events')
        .select('case_id', { count: 'exact', head: true })
        .eq('new_handler_role', roleType)
        .gt('created_at', since);
    if (error) throw error;
    return count ?? 0;
}

export async function getUnreadNotifCount() {
    const { data, error } = await supabase.rpc('fn_count_unread_notifications');
    if (error) throw error;
    return Number(data ?? 0);
}

export async function getRecentNotifications(limit = 20) {
    const { data, error } = await supabase
        .from('notifications')
        .select('notification_id, type, title, body, is_read, case_id, created_at')
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data ?? [];
}

export async function markNotificationsRead(ids) {
    if (!ids?.length) return;
    const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .in('notification_id', ids);
    if (error) throw error;
}

export async function getCases({ status = '', track = '', offset = 0, limit = 51 } = {}) {
    let req = supabase
        .from('cases')
        .select(`
            case_id, title, status, track, current_handler_role, is_locked,
            created_at, created_by_user_id,
            student:students(student_id, full_name, nis)
        `)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (status) req = req.eq('status', status);
    if (track)  req = req.eq('track', track);
    const { data, error } = await req;
    if (error) throw error;
    return data ?? [];
}

export async function getCase(caseId) {
    const { data, error } = await supabase
        .from('cases')
        .select(`
            case_id, title, description, status, track, current_handler_role, is_locked,
            created_at, initiated_by_role, audience,
            student:students(student_id, user_id, full_name, nis),
            created_by:users!cases_created_by_user_id_fkey(full_name)
        `)
        .eq('case_id', caseId)
        .single();
    if (error) throw error;
    return data;
}

export async function getCaseEvents(caseId) {
    const { data, error } = await supabase
        .from('case_events')
        .select(`
            event_id, event_type, privacy_level,
            previous_handler_role, new_handler_role,
            previous_status, new_status, payload, created_at,
            author:users!case_events_author_user_id_fkey(full_name),
            author_role_at_time
        `)
        .eq('case_id', caseId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
}

export async function createCase({ studentId, title, description, track, audience = 'PRIVATE', authorUserId, authorRole }) {
    const payload = {
        idempotency_key:    crypto.randomUUID(),
        case_id:            crypto.randomUUID(),
        student_id:         studentId,
        created_by_user_id: authorUserId,
        initiated_by_role:  authorRole,
        track,
        title,
        description,
        audience,
    };
    const r = await saveCase(payload);
    if (r.status === 'error') throw new Error(r.error);
    return { case_id: payload.case_id, _queued: r.status === 'queued' };
}

export async function updateCaseAudience({ caseId, audience }) {
    const { data, error } = await supabase
        .from('cases')
        .update({ audience })
        .eq('case_id', caseId)
        .select('case_id');
    if (error) throw error;
    if (!data || data.length === 0) throw new Error('Tidak ada perubahan tersimpan — periksa izin Anda.');
}

export async function getCaseAudienceMembers(caseId) {
    const { data, error } = await supabase
        .from('case_audience_members')
        .select('user_id, users:user_id(full_name, role_type)')
        .eq('case_id', caseId);
    if (error) throw error;
    return data ?? [];
}

export async function addCaseAudienceMember({ caseId, userId, schoolId, addedByUserId }) {
    const { error } = await supabase
        .from('case_audience_members')
        .insert({ case_id: caseId, user_id: userId, school_id: schoolId, added_by_user_id: addedByUserId });
    if (error) throw error;
}

export async function removeCaseAudienceMember({ caseId, userId }) {
    const { error } = await supabase
        .from('case_audience_members')
        .delete()
        .eq('case_id', caseId)
        .eq('user_id', userId);
    if (error) throw error;
}

export async function searchInternalUsers(query) {
    const INTERNAL_ROLES = ['GURU','BK','WALI_KELAS','WAKA_KESISWAAN','KEPSEK'];
    const { data, error } = await supabase
        .from('v_users_staff_directory')
        .select('user_id, full_name, role_type')
        .in('role_type', INTERNAL_ROLES)
        .ilike('full_name', `%${query}%`)
        .eq('is_active', true)
        .limit(10);
    if (error) throw error;
    return data ?? [];
}

export async function addCaseComment({ caseId, text, authorUserId, authorRole, privacyLevel = 'INTERNAL_SCHOOL' }) {
    const { error } = await supabase
        .from('case_events')
        .insert({
            case_id:            caseId,
            event_type:         'COMMENT_ADDED',
            author_user_id:     authorUserId,
            author_role_at_time: authorRole,
            privacy_level:      privacyLevel,
            payload:            { text },
        });
    if (error) throw error;
}

export async function escalateCase({ caseId, previousHandlerRole, newHandlerRole, note, authorUserId, authorRole, previousStatus }) {
    // previousStatus wajib diisi oleh pemanggil; fetch dari server sebagai fallback
    let prevSt = previousStatus;
    if (!prevSt) {
        const { data, error: fetchErr } = await supabase
            .from('cases')
            .select('status')
            .eq('case_id', caseId)
            .single();
        if (fetchErr) throw fetchErr;
        prevSt = data.status;
    }

    const { error } = await supabase
        .from('case_events')
        .insert({
            case_id:               caseId,
            event_type:            'DECISION_ESCALATE',
            author_user_id:        authorUserId,
            author_role_at_time:   authorRole,
            previous_handler_role: previousHandlerRole,
            new_handler_role:      newHandlerRole,
            previous_status:       prevSt,
            new_status:            prevSt,   // eskalasi tidak mengubah status kasus
            payload:               note ? { text: note } : {},
        });
    if (error) throw error;

    // Jika kasus PRIVATE, otomatis upgrade audience ke RESTRICTED
    // agar handler baru bisa lihat kasus
    const { data: caseData } = await supabase
        .from('cases')
        .select('audience')
        .eq('case_id', caseId)
        .single();

    if (caseData?.audience === 'PRIVATE') {
        await updateCaseAudience({ caseId, audience: 'RESTRICTED' });
        await logCaseAudienceChange({
            caseId,
            previousAudience: 'PRIVATE',
            newAudience: 'RESTRICTED',
            authorUserId,
            authorRole,
        });
    }
}

export async function changeCaseStatus({ caseId, previousStatus, newStatus, note, authorUserId, authorRole }) {
    const { error } = await supabase
        .from('case_events')
        .insert({
            case_id:             caseId,
            event_type:          'STATUS_CHANGED',
            author_user_id:      authorUserId,
            author_role_at_time: authorRole,
            previous_status:     previousStatus,
            new_status:          newStatus,
            payload:             note ? { text: note } : {},
        });
    if (error) throw error;
}

export async function closeCase({ caseId, note, authorUserId, authorRole, previousStatus }) {
    const { error } = await supabase
        .from('case_events')
        .insert({
            case_id:             caseId,
            event_type:          'DECISION_CLOSE',
            author_user_id:      authorUserId,
            author_role_at_time: authorRole,
            previous_status:     previousStatus ?? null,
            new_status:          'CLOSED',
            payload:             note ? { text: note } : {},
        });
    if (error) throw error;
}

export async function logCaseAudienceChange({ caseId, previousAudience, newAudience, authorUserId, authorRole }) {
    const { error } = await supabase
        .from('case_events')
        .insert({
            case_id:             caseId,
            event_type:          'AUDIENCE_CHANGED',
            author_user_id:      authorUserId,
            author_role_at_time: authorRole,
            payload:             { previous: previousAudience, next: newAudience },
        });
    if (error) console.warn('[kasus] audit audience change gagal:', error);
}

// ─── KELOLA ADMIN (kepsek only) ───────────────────────────────

export async function listSchoolAdmins() {
    const { data, error } = await supabase
        .from('v_users_staff_directory')
        .select('user_id, full_name')
        .eq('role_type', 'ADMINISTRATIVE')
        .eq('is_active', true)
        .order('full_name');
    if (error) throw error;
    return data ?? [];
}

async function _callManageAdmin(method, body) {
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) throw new Error('Sesi login tidak ditemukan. Silakan login ulang.');

    const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-admin-account`, {
        method,
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message ?? 'Permintaan gagal');
    return json.data;
}

export async function addSchoolAdmin({ full_name, login_identifier, identifier_type }) {
    return _callManageAdmin('POST', { full_name, login_identifier, identifier_type });
}

export async function removeSchoolAdmin(user_id) {
    return _callManageAdmin('DELETE', { user_id });
}

// ─── Forum Kelas ──────────────────────────────────────────────

export async function getForumClasses(userId, academicYear) {
    const classMap = new Map();

    // Ambil profil user dulu — dibutuhkan untuk menentukan query selanjutnya
    const { data: u } = await supabase.from('users')
        .select('wali_kelas_class_id, role_type, is_waka_kesiswaan, is_kepsek')
        .eq('user_id', userId)
        .maybeSingle();

    const isOversight = ['WAKA_KESISWAAN', 'KEPSEK', 'ADMINISTRATIVE'].includes(u?.role_type)
        || u?.is_waka_kesiswaan === true
        || u?.is_kepsek === true;

    // Jalankan semua query independen secara paralel
    const [cls, ta, bk, gwa, allCls] = await Promise.all([
        // 1. Wali kelas
        u?.wali_kelas_class_id
            ? supabase.from('classes').select('class_id, name').eq('class_id', u.wali_kelas_class_id).maybeSingle().then(r => r.data)
            : Promise.resolve(null),
        // 2. Guru mapel
        supabase.from('teaching_assignments').select('class:classes(class_id, name)')
            .eq('user_id', userId).eq('academic_year', academicYear).eq('is_active', true).then(r => r.data),
        // 3. BK
        supabase.from('bk_class_assignments').select('class:classes(class_id, name)')
            .eq('bk_user_id', userId).eq('academic_year', academicYear).eq('is_active', true).then(r => r.data),
        // 4a. Guru wali (hasil dipakai untuk query enrollments berikutnya)
        supabase.from('guru_wali_assignments').select('student_id')
            .eq('guru_user_id', userId).eq('academic_year', academicYear).eq('is_active', true).then(r => r.data),
        // 5. Oversight → semua kelas
        isOversight
            ? supabase.from('classes').select('class_id, name').eq('academic_year', academicYear).then(r => r.data)
            : Promise.resolve(null),
    ]);

    if (cls) classMap.set(cls.class_id, cls.name);
    (ta  ?? []).forEach(r => r.class && classMap.set(r.class.class_id, r.class.name));
    (bk  ?? []).forEach(r => r.class && classMap.set(r.class.class_id, r.class.name));
    (allCls ?? []).forEach(c => classMap.set(c.class_id, c.name));

    // 4b. Enrollments — dependen pada hasil gwa, dijalankan setelah batch pertama
    if (gwa?.length) {
        const { data: enr } = await supabase.from('class_enrollments')
            .select('class:classes(class_id, name)')
            .in('student_id', gwa.map(r => r.student_id))
            .eq('academic_year', academicYear)
            .is('withdrawn_at', null);
        (enr ?? []).forEach(r => r.class && classMap.set(r.class.class_id, r.class.name));
    }

    return Array.from(classMap, ([class_id, name]) => ({ class_id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'id'));
}

export async function getForumPosts(classId, academicYear, callerId, schoolId, limit = 20, offset = 0, skipAudienceFilter = false) {
    // Waka/Kepsek/Kaprodi tidak perlu filter audience — RLS sudah guard akses.
    // User biasa hanya melihat posting yang ada di audience-nya.
    const audienceSel = skipAudienceFilter
        ? 'forum_post_audience(user_id)'
        : 'forum_post_audience!inner(user_id)';
    let q = supabase
        .from('forum_posts')
        .select(`
            post_id, title, body, visibility, is_pinned, is_withdrawn,
            created_at, updated_at, author_user_id,
            category:communication_categories(category_code, label_sekolah, polarity),
            author:users!forum_posts_author_user_id_fkey(user_id, full_name),
            subjects:forum_post_subjects(
                student:students(student_id, full_name, nis)
            ),
            acknowledgements:forum_post_acknowledgements(user_id),
            comments:forum_post_comments(comment_id),
            ${audienceSel}
        `)
        .eq('class_id',    classId)
        .eq('academic_year', academicYear)
        .eq('school_id',   schoolId)
        .order('is_pinned',  { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (!skipAudienceFilter) {
        q = q.eq('forum_post_audience.user_id', callerId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map(({ forum_post_audience: _aud, ...rest }) => rest);
}

export async function getForumPostComments(postId) {
    const { data, error } = await supabase
        .from('forum_post_comments')
        .select(`
            comment_id, body, created_at, author_user_id,
            author:users!forum_post_comments_author_user_id_fkey(user_id, full_name)
        `)
        .eq('post_id', postId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
}

export async function getForumCategories() {
    const { data, error } = await supabase
        .from('communication_categories')
        .select('category_id, category_code, label_sekolah, polarity, display_order')
        .eq('is_active', true)
        .order('display_order');
    if (error) throw error;
    return data ?? [];
}

export async function getForumStudents(classId, academicYear) {
    const { data, error } = await supabase
        .from('class_enrollments')
        .select('student:students(student_id, full_name, nis)')
        .eq('class_id', classId)
        .eq('academic_year', academicYear)
        .is('withdrawn_at', null);
    if (error) throw error;
    return (data ?? [])
        .map(r => r.student)
        .filter(Boolean)
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'id'));
}

export async function getForumMemberDetails(classId, academicYear) {
    const { data, error } = await supabase.rpc(
        'fn_get_forum_member_details',
        {
            p_class_id:      classId,
            p_academic_year: academicYear,
        }
    );
    if (error) throw error;
    return (data ?? []).map(r => ({
        user_id:      r.user_id,
        full_name:    r.full_name,
        role_type:    r.role_type,
        student_name: r.student_name ?? null,
    }));
}

export async function createForumPost(
    classId, academicYear, content,
    categoryCode, subjectStudentIds, audienceType,
    specificUserIds = [],
    audienceType2 = null,
    specificUserIds2 = []
) {
    const { data, error } = await supabase.rpc('fn_create_forum_post', {
        p_class_id:              classId,
        p_academic_year:         academicYear,
        p_content:               content,
        p_category_code:         categoryCode || null,
        p_subject_student_ids:   subjectStudentIds ?? [],
        p_audience_type:         audienceType,
        p_specific_user_ids:     specificUserIds,
        p_audience_type_2:       audienceType2 || null,
        p_specific_user_ids_2:   specificUserIds2,
    });
    if (error) throw error;
    return data;
}

export async function addForumAcknowledgement(postId, userId, schoolId) {
    const { error } = await supabase.from('forum_post_acknowledgements')
        .insert({ post_id: postId, user_id: userId, school_id: schoolId });
    // 23505 = unique_violation: sudah di-ack sebelumnya — abaikan
    if (error && error.code !== '23505') throw error;
}

export async function addForumComment(postId, body, authorUserId, schoolId) {
    const { data, error } = await supabase.from('forum_post_comments')
        .insert({ post_id: postId, body, author_user_id: authorUserId, school_id: schoolId })
        .select('comment_id')
        .single();
    if (error) throw error;
    return data;
}

export async function withdrawForumPost(postId) {
    const { error } = await supabase.from('forum_posts')
        .update({ is_withdrawn: true })
        .eq('post_id', postId);
    if (error) throw error;
}

export async function updateForumPost(postId, newBody) {
    const { error } = await supabase.from('forum_posts')
        .update({ body: newBody, updated_at: new Date().toISOString() })
        .eq('post_id', postId);
    if (error) throw error;
}

export async function withdrawForumComment(commentId) {
    const { error } = await supabase.from('forum_post_comments')
        .delete()
        .eq('comment_id', commentId);
    if (error) throw error;
}

// ─── PERANGKAT AJAR (Sprint 2) ───────────────────────────────

export async function getCoreSubjects() {
    const { data, error } = await supabase
        .from('core_subjects_view')
        .select('subject_id, code, name, subject_type, program_id')
        .eq('is_active', true)
        .order('name');
    if (error) {
        // Fallback: query langsung ke skema core via rpc jika view belum ada
        const { data: d2, error: e2 } = await supabase.rpc('fn_get_core_subjects');
        if (e2) throw e2;
        return d2 ?? [];
    }
    return data ?? [];
}

export async function getCoreSubjectsDirect() {
    const { data, error } = await supabase
        .from('v_core_subjects')
        .select('subject_id, code, name, subject_type');
    if (error) throw error;
    return data ?? [];
}

export async function getCorePhases() {
    // Phase IDs sudah diketahui dari seed Sprint 1 (fixed UUIDs)
    return [
        { phase_id: '00000000-0000-0000-0002-000000000001', code: 'E', name: 'Fase E (Kelas X SMK)' },
        { phase_id: '00000000-0000-0000-0002-000000000002', code: 'F', name: 'Fase F (Kelas XI–XII SMK)' },
    ];
}

export async function getMyTeacherDocuments(schoolId, academicYear) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
        .from('teacher_documents')
        .select('doc_id, document_type, status, semester, academic_year, core_subject_id, phase_id, content_json, created_at, updated_at')
        .eq('school_id', schoolId)
        .eq('academic_year', academicYear)
        .eq('teacher_user_id', user.id)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
}

export async function createTeacherDocument({ schoolId, academicYear, documentType, coreSubjectId, phaseId, programId, scopeType, semester, tpUrutan, contentJson }) {
    // teacher_user_id harus = auth.uid() (FK ke auth.users), bukan user_id dari public.users
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Sesi tidak ditemukan. Silakan login ulang.');
    const { data, error } = await supabase
        .from('teacher_documents')
        .insert({
            school_id:       schoolId,
            teacher_user_id: user.id,
            academic_year:   academicYear,
            document_type:   documentType,
            core_subject_id: coreSubjectId,
            phase_id:        phaseId,
            program_id:      programId ?? null,
            scope_type:      scopeType ?? 'SEMUA_KELAS',
            semester:        semester ?? null,
            tp_urutan:       tpUrutan ?? null,
            status:          'AI_DRAFT',
            content_json:    contentJson ?? {},
        })
        .select('doc_id')
        .single();
    if (error) throw error;
    return data;
}

export async function updateDocumentStatus(docId, newStatus) {
    const { error } = await supabase
        .from('teacher_documents')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('doc_id', docId);
    if (error) throw error;
}

export async function getPendingDocApprovals(schoolId) {
    const { data, error } = await supabase
        .from('teacher_documents')
        .select(`
            doc_id, document_type, academic_year, semester, status, created_at,
            content_json,
            core_subject_id,
            phase_id
        `)
        .eq('school_id', schoolId)
        .eq('status', 'MENUNGGU_WAKA')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data ?? [];
}

export async function getKepsekApprovalHistory(schoolId) {
    // Query approvals dulu (tanpa embed — FK join PostgREST tidak reliable)
    const { data, error } = await supabase
        .from('teacher_document_approvals')
        .select('approval_id, doc_id, status, approved_at, catatan')
        .eq('school_id', schoolId)
        .order('approved_at', { ascending: false })
        .limit(20);
    if (error) throw error;
    if (!data?.length) return [];

    // Fetch teacher_documents terpisah berdasarkan doc_id
    const docIds = [...new Set(data.map(r => r.doc_id).filter(Boolean))];
    const { data: docs } = await supabase
        .from('teacher_documents')
        .select('doc_id, document_type, academic_year, semester, core_subject_id, phase_id, teacher_user_id')
        .in('doc_id', docIds);
    const docMap = new Map((docs ?? []).map(d => [d.doc_id, d]));

    // Fetch nama mapel dari v_core_subjects
    const subjectIds = [...new Set((docs ?? []).map(d => d.core_subject_id).filter(Boolean))];
    let subjectMap = new Map();
    if (subjectIds.length) {
        const { data: subjects } = await supabase
            .from('v_core_subjects')
            .select('subject_id, name')
            .in('subject_id', subjectIds);
        subjectMap = new Map((subjects ?? []).map(s => [s.subject_id, s.name]));
    }

    // Fetch nama guru via auth_user_id
    const authIds = [...new Set((docs ?? []).map(d => d.teacher_user_id).filter(Boolean))];
    let nameMap = new Map();
    if (authIds.length) {
        const { data: users } = await supabase
            .from('users')
            .select('auth_user_id, full_name')
            .in('auth_user_id', authIds);
        nameMap = new Map((users ?? []).map(u => [u.auth_user_id, u.full_name]));
    }

    return data.map(r => {
        const td = docMap.get(r.doc_id) ?? null;
        return {
            ...r,
            teacher_documents: td,
            teacher_name:  td ? (nameMap.get(td.teacher_user_id) ?? null) : null,
            subject_name:  td ? (subjectMap.get(td.core_subject_id) ?? null) : null,
        };
    });
}

export async function getWakaApprovalHistory(schoolId) {
    const { data, error } = await supabase
        .from('teacher_document_approvals')
        .select('approval_id, doc_id, status, approved_at, catatan')
        .eq('school_id', schoolId)
        .order('approved_at', { ascending: false })
        .limit(20);
    if (error) throw error;
    if (!data?.length) return [];

    const docIds = [...new Set(data.map(r => r.doc_id).filter(Boolean))];
    const { data: docs } = await supabase
        .from('teacher_documents')
        .select('doc_id, document_type, academic_year, semester, core_subject_id, phase_id, teacher_user_id')
        .in('doc_id', docIds);
    const docMap = new Map((docs ?? []).map(d => [d.doc_id, d]));

    const subjectIds = [...new Set((docs ?? []).map(d => d.core_subject_id).filter(Boolean))];
    let subjectMap = new Map();
    if (subjectIds.length) {
        const { data: subjects } = await supabase
            .from('v_core_subjects')
            .select('subject_id, name')
            .in('subject_id', subjectIds);
        subjectMap = new Map((subjects ?? []).map(s => [s.subject_id, s.name]));
    }

    const authIds = [...new Set((docs ?? []).map(d => d.teacher_user_id).filter(Boolean))];
    let nameMap = new Map();
    if (authIds.length) {
        const { data: users } = await supabase
            .from('users')
            .select('auth_user_id, full_name')
            .in('auth_user_id', authIds);
        nameMap = new Map((users ?? []).map(u => [u.auth_user_id, u.full_name]));
    }

    return data.map(r => {
        const td = docMap.get(r.doc_id) ?? null;
        return {
            ...r,
            teacher_documents: td,
            teacher_name:  td ? (nameMap.get(td.teacher_user_id) ?? null) : null,
            subject_name:  td ? (subjectMap.get(td.core_subject_id) ?? null) : null,
        };
    });
}

export async function deleteTeacherDocument(docId) {
    await supabase
        .from('teacher_document_approvals')
        .delete()
        .eq('doc_id', docId);

    await supabase
        .from('teacher_document_classes')
        .delete()
        .eq('doc_id', docId);

    const { error } = await supabase
        .from('teacher_documents')
        .delete()
        .eq('doc_id', docId);

    if (error) throw error;
}

export async function wakaApproveDoc(docId, action, catatan = null) {
    const { error } = await supabase.rpc('fn_waka_approve_doc', {
        p_doc_id:  docId,
        p_action:  action,
        p_catatan: catatan ?? null,
    });
    if (error) throw error;
}

export async function getDisahkanWakaDocs(schoolId) {
    const { data, error } = await supabase
        .from('teacher_documents')
        .select(`
            doc_id, document_type, academic_year, semester,
            updated_at, core_subject_id, phase_id, teacher_user_id
        `)
        .eq('school_id', schoolId)
        .eq('status', 'DISAHKAN_WAKA')
        .order('updated_at', { ascending: false })
        .limit(50);
    if (error) throw error;
    if (!data?.length) return [];

    const authIds = [...new Set(data.map(d => d.teacher_user_id).filter(Boolean))];
    const { data: users } = await supabase
        .from('users')
        .select('auth_user_id, full_name')
        .in('auth_user_id', authIds);
    const nameMap = new Map((users ?? []).map(u => [u.auth_user_id, u.full_name]));

    return data.map(d => ({ ...d, teacher_name: nameMap.get(d.teacher_user_id) ?? null }));
}

export async function getTeacherProfile(schoolId) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
        .from('teacher_profiles')
        .select('*')
        .eq('school_id', schoolId)
        .eq('teacher_user_id', user.id)
        .maybeSingle();
    if (error) throw error;
    return data ?? null;
}

export async function saveTeacherProfile(schoolId, profile) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
        .from('teacher_profiles')
        .upsert({
            school_id: schoolId,
            teacher_user_id: user.id,
            ...profile,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'school_id,teacher_user_id' });
    if (error) throw error;
}

export async function getTeachingContext(schoolId, subjectId, academicYear) {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
        .from('teaching_contexts')
        .select('*')
        .eq('school_id', schoolId)
        .eq('teacher_user_id', user.id)
        .eq('academic_year', academicYear)
        .eq('subject_id', subjectId)
        .maybeSingle();
    if (error) throw error;
    return data ?? null;
}

export async function saveTeachingContext(schoolId, context) {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
        .from('teaching_contexts')
        .upsert({
            school_id: schoolId,
            teacher_user_id: user.id,
            ...context,
            updated_at: new Date().toISOString(),
        }, {
            onConflict: 'school_id,teacher_user_id,academic_year,subject_id,class_id',
        });
    if (error) throw error;
}
