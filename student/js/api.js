/**
 * @file student/js/api.js
 * Supabase wrapper untuk Portal Siswa.
 *
 * Identitas: siswa login pakai NIS (login_identifier di tabel users),
 * lalu user_id-nya tertaut ke baris students lewat students.user_id.
 * Semua data dibatasi RLS self-scoped (rls_*_read_student di
 * contracts/06_rls_policies.sql + migrasi SISWA read schedules/pkl).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL      = 'https://dfugplddogrbzrwxifdf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_A5QPhZVwzmAQKGtKB49sHQ_loIkEug-';

try {
    const _mk = 'sb-dfugplddogrbzrwxifdf-auth-token';
    const _lv = localStorage.getItem(_mk);
    if (_lv && !sessionStorage.getItem(_mk)) { sessionStorage.setItem(_mk, _lv); localStorage.removeItem(_mk); }
} catch { /* private mode */ }

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: true, storage: sessionStorage },
});

// Role yang boleh masuk portal ini
export const STUDENT_ROLES = ['SISWA'];

// Status siswa yang masih boleh mengakses Portal Siswa.
// LULUS (alumni) & KELUAR (mutasi) diblokir.
export const ACTIVE_STUDENT_STATUSES = ['AKTIF'];

export async function loginWithIdentifier(identifier, password, schoolId = null) {
    const { data: email, error: resolveErr } = await supabase
        .rpc('fn_resolve_login_email', { p_identifier: identifier, p_school_id: schoolId });
    if (resolveErr) throw new Error('Gagal menghubungi server. Coba lagi.');
    if (!email) throw new Error('NIS tidak ditemukan. Hubungi admin sekolah untuk memastikan akun sudah dibuat.');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        if (error.status === 429 || /rate limit|too many/i.test(error.message || ''))
            throw new Error('Terlalu banyak percobaan login. Tunggu ±15 menit lalu coba lagi.');
        throw new Error('Password salah. Jika baru pertama login, hubungi admin sekolah untuk password sementara Anda.');
    }
}

export async function logout() {
    await supabase.auth.signOut();
}

export async function getCurrentUserRow(authUser = null) {
    const user = authUser ?? (await supabase.auth.getUser()).data?.user;
    if (!user) return null;
    const { data, error } = await supabase
        .from('users')
        .select('user_id, school_id, full_name, role_type, login_identifier, is_active, must_change_password, last_seen_at, last_seen_ua')
        .eq('auth_user_id', user.id)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/**
 * Baris students milik user yang sedang login (lewat students.user_id).
 * Returns null jika akun SISWA belum tertaut ke data siswa.
 */
export async function getMyStudent(userId) {
    const { data, error } = await supabase
        .from('students')
        .select('student_id, nis, full_name, student_status, program:programs ( name )')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) throw error;
    return data;
}

export async function getSchoolConfig() {
    const { data } = await supabase
        .from('school_config')
        .select('current_academic_year, current_semester')
        .single();
    return data;
}

/**
 * Kelas siswa pada tahun ajaran berjalan (enrollment aktif / belum withdrawn).
 */
export async function getMyClass(studentId, academicYear) {
    const { data, error } = await supabase
        .from('class_enrollments')
        .select('class_id, academic_year, class:classes ( name, grade_level )')
        .eq('student_id', studentId)
        .eq('academic_year', academicYear)
        .is('withdrawn_at', null)
        .maybeSingle();
    if (error) throw error;
    return data;
}

/**
 * Jadwal kelas siswa pada tanggal tertentu.
 * Catatan RLS: butuh kebijakan SISWA read teaching_schedules + class_enrollments
 * (migrasi 20260630180000_student_read_schedules_pkl.sql). Tanpa itu hasil kosong.
 */
export async function getScheduleForDate(classId, date) {
    if (!classId) return [];
    const { data, error } = await supabase
        .from('teaching_schedules')
        .select(`
            schedule_id, session_date, session_start, session_end,
            subject:subjects ( name ),
            teacher:users ( full_name ),
            class:classes ( name )
        `)
        .eq('class_id', classId)
        .eq('session_date', date)
        .order('session_start');
    if (error) throw error;
    return data ?? [];
}

/**
 * Kehadiran diri sendiri dalam rentang tanggal.
 * RLS rls_attendance_read_student membatasi otomatis ke student_id ini (non-void).
 */
export async function getMyAttendance(studentId, dateStart, dateEnd) {
    let q = supabase
        .from('teaching_schedules')
        .select(`
            schedule_id,
            block_group_id,
            session_date,
            session_start,
            session_end,
            subject:subjects ( name ),
            teacher:users!teaching_schedules_scheduled_teacher_id_fkey ( full_name ),
            attendance!inner ( attendance_id, status, is_void, notes )
        `)
        .eq('attendance.student_id', studentId)
        .eq('attendance.is_void', false)
        .order('session_date', { ascending: false })
        .order('session_start', { ascending: true });

    if (dateStart) q = q.gte('session_date', dateStart);
    if (dateEnd)   q = q.lte('session_date', dateEnd);

    const { data, error } = await q;
    if (error) throw error;

    // Group by block_group_id
    const blockMap = new Map();
    for (const sched of (data ?? [])) {
        const att = (sched.attendance ?? [])[0];
        if (!att) continue;
        const key = sched.block_group_id ?? `${sched.session_date}_${sched.session_start}`;
        if (!blockMap.has(key)) {
            blockMap.set(key, {
                block_group_id:  key,
                date:            sched.session_date,
                subject:         sched.subject?.name ?? 'KBM',
                teacher:         sched.teacher?.full_name ?? '—',
                slots:           [],
            });
        }
        blockMap.get(key).slots.push({
            start:  sched.session_start?.slice(0, 5),
            end:    sched.session_end?.slice(0, 5),
            status: att.status === 'EKSKUL' ? 'HADIR' : att.status,
            notes:  att.notes ?? '',
        });
    }

    return Array.from(blockMap.values()).map(block => {
        const statuses = block.slots.map(s => s.status);
        const unique   = [...new Set(statuses)];
        const summary  = unique.length === 1 ? unique[0] : 'CAMPURAN';
        const first    = block.slots[0];
        const last     = block.slots[block.slots.length - 1];
        return {
            ...block,
            time_range:     `${first.start} – ${last.end}`,
            summary_status: summary,
        };
    });
}

/**
 * Kasus audience=RESTRICTED yang menyangkut siswa ini.
 * RLS rls_cases_read_student membatasi otomatis.
 */
export async function getMyCases(studentId) {
    const { data, error } = await supabase
        .from('cases')
        .select(`
            case_id, title, description, status, audience, created_at,
            initiated_by_role, current_handler_role,
            events:case_events (
                event_id, event_type, payload, created_at, privacy_level,
                author:users!case_events_author_user_id_fkey ( full_name )
            )
        `)
        .eq('student_id', studentId)
        .eq('audience', 'RESTRICTED')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(c => ({
        ...c,
        events: (c.events ?? [])
            .filter(e => e.privacy_level === 'STUDENT_VISIBLE')
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }));
}

/**
 * Catatan siswa yang boleh dilihat siswa ini.
 * RLS rls_observations_read_student membatasi ke visibility
 * SISWA_SAJA atau SISWA_DAN_ORTU untuk student_id yang cocok.
 */
export async function getMyObservations(studentId, dateStart = null, dateEnd = null) {
    let query = supabase
        .from('observations')
        .select(`
            observation_id, dimension, sentiment, content, observed_at, created_at,
            author:users!observations_author_user_id_fkey ( full_name )
        `)
        .eq('student_id', studentId)
        .order('observed_at', { ascending: false })
        .limit(100);
    if (dateStart) query = query.gte('observed_at', dateStart);
    if (dateEnd)   query = query.lte('observed_at', dateEnd + 'T23:59:59');
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
}

export async function getUnreadNotifCount() {
    const { data, error } = await supabase.rpc('fn_count_unread_notifications');
    if (error) throw error;
    return Number(data ?? 0);
}

export async function getRecentNotifications(limit = 15) {
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

/**
 * Kelas aktif siswa yang login untuk keperluan forum.
 * Menggunakan students.user_id = auth.uid() via RLS, lalu join class_enrollments.
 * Return: { class_id, class_name, academic_year } atau null.
 */
export async function getMyForumClass(userId) {
    const { data: student, error: sErr } = await supabase
        .from('students')
        .select('student_id')
        .eq('user_id', userId)
        .eq('student_status', 'AKTIF')
        .maybeSingle();
    if (sErr) throw sErr;
    if (!student) return null;

    const { data: config } = await supabase
        .from('school_config')
        .select('current_academic_year')
        .single();
    if (!config?.current_academic_year) return null;

    const { data, error } = await supabase
        .from('class_enrollments')
        .select('class_id, academic_year, class:classes ( name )')
        .eq('student_id', student.student_id)
        .eq('academic_year', config.current_academic_year)
        .is('withdrawn_at', null)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
        class_id:      data.class_id,
        class_name:    data.class?.name ?? '',
        academic_year: data.academic_year,
    };
}

/**
 * Posting forum kelas yang dapat dibaca siswa ini
 * (dibatasi via forum_post_audience + fn_can_read_forum_post di RLS).
 */
export async function getForumPosts(classId, academicYear, userId, schoolId, limit = 20, offset = 0) {
    const { data, error } = await supabase
        .from('forum_posts')
        .select(`
            post_id, title, body, visibility, is_pinned, created_at, updated_at,
            author_user_id,
            category:communication_categories ( category_code, label_sekolah, polarity ),
            author:users!forum_posts_author_user_id_fkey ( user_id, full_name ),
            subjects:forum_post_subjects (
                student:students ( student_id, full_name, nis )
            ),
            acknowledgements:forum_post_acknowledgements ( user_id ),
            comments:forum_post_comments (
                comment_id, body, created_at,
                author:users!forum_post_comments_author_user_id_fkey ( user_id, full_name )
            ),
            forum_post_audience!inner ( user_id )
        `)
        .eq('class_id', classId)
        .eq('academic_year', academicYear)
        .eq('school_id', schoolId)
        .eq('forum_post_audience.user_id', userId)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data ?? []).map(p => {
        const { forum_post_audience: _aud, ...rest } = p;
        return rest;
    });
}

/**
 * Siswa menandai posting sudah dibaca (acknowledgement).
 * Idempoten — duplikat diabaikan via onConflict ignore.
 */
export async function getMyAchievements(studentId) {
    // TODO: Phase 1 SMA — Dashboard Prestasi belum diimplementasi
    // View v_student_portal_achievements belum ada di DB
    // Aktifkan kembali setelah view dibuat
    void studentId;
    return [];
}

export async function addForumAck(postId, userId, schoolId) {
    const { error } = await supabase
        .from('forum_post_acknowledgements')
        .upsert(
            { post_id: postId, user_id: userId, school_id: schoolId },
            { onConflict: 'post_id,user_id', ignoreDuplicates: true }
        );
    if (error) throw error;
}
