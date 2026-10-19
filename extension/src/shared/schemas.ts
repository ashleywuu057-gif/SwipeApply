import { z } from 'zod';

/** 持久化与交换格式的运行时校验。与 types.ts 的结构合同保持一致。 */

export const MAX_TEXT = 10_000;
export const MAX_RECORDS_PER_SECTION = 20;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const text = (max = MAX_TEXT) => z.string().max(max, `文本超过 ${max} 字符上限`);
const nullableText = (max = MAX_TEXT) => text(max).nullable();

const isoDateTime = z.string().refine(
  (v) => !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v),
  '需要 UTC ISO 时间字符串',
);

const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, '只接受 http/https 链接');

const email = z
  .string()
  .max(320)
  .refine((v) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v), '邮箱格式不正确');

const phone = z
  .string()
  .max(32)
  .refine((v) => /^[+]?[0-9][0-9\s()-]{4,}$/.test(v), '电话号码格式不正确');

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const partialDateSchema = z
  .object({
    year: z.number().int().min(1900).max(2100),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.day !== undefined && value.month === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['day'], message: '有“日”必须同时有“月”' });
      return;
    }
    if (value.day !== undefined && value.month !== undefined) {
      if (value.day > daysInMonth(value.year, value.month)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['day'], message: '该月份不存在这一天' });
      }
    }
  });

export const presentSchema = z.object({ present: z.literal(true) }).strict();
export const endDateSchema = z.union([partialDateSchema, presentSchema]);

export const degreeLevelSchema = z.enum(['bachelor', 'master', 'doctor', 'associate', 'other']);
export const genderSchema = z.enum(['male', 'female', 'other']);

export const idSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/, 'ID 只允许字母、数字与 . _ : -');

function uniqueIds<T extends { id: string }>(label: string) {
  return (records: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (seen.has(record.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `${label} 中存在重复 ID` });
      }
      seen.add(record.id);
    });
  };
}

const listOf = <T extends z.ZodTypeAny>(schema: T, label: string) =>
  z.array(schema).max(MAX_RECORDS_PER_SECTION, `${label} 最多 ${MAX_RECORDS_PER_SECTION} 条`);

export const educationSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    school: text(200).min(1, '学校不能为空'),
    department: nullableText(200),
    degreeLevel: degreeLevelSchema,
    enrollmentStatus: z.enum(['enrolled', 'graduated']).nullable(),
    major: nullableText(200),
    startDate: partialDateSchema.nullable(),
    endDate: partialDateSchema.nullable(),
    gpa: nullableText(32),
    gpaScale: nullableText(32),
    description: nullableText(),
    educationType: z.enum(['fullTimeUnified', 'fullTime', 'partTime', 'other']).nullable().optional(),
    majorRanking: nullableText(50).optional(),
    lab: nullableText(300).optional(),
    researchDirection: nullableText(300).optional(),
    advisor: nullableText(100).optional(),
    advisorResearchDirection: nullableText(300).optional(),
    studentNumber: nullableText(100).optional(),
  })
  .strict();

export const internshipSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    company: text(200).min(1, '公司不能为空'),
    department: nullableText(200),
    title: nullableText(200),
    city: nullableText(100),
    startDate: partialDateSchema.nullable(),
    endDate: endDateSchema.nullable(),
    description: nullableText(),
  })
  .strict();

export const projectSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    name: text(200).min(1, '项目名称不能为空'),
    role: nullableText(200),
    startDate: partialDateSchema.nullable(),
    endDate: endDateSchema.nullable(),
    url: httpUrl.nullable(),
    description: nullableText(),
  })
  .strict();

export const languageSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    language: text(100).min(1, '语言不能为空'),
    certificate: nullableText(100),
    score: nullableText(50),
    examDate: partialDateSchema.nullable(),
    proficiency: nullableText(50).optional(),
    listeningSpeaking: nullableText(50).optional(),
    readingWriting: nullableText(50).optional(),
  })
  .strict();

export const workExperienceSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    company: text(200).min(1, '公司不能为空'),
    department: nullableText(200),
    title: nullableText(200),
    city: nullableText(100),
    startDate: partialDateSchema.nullable(),
    endDate: endDateSchema.nullable(),
    description: nullableText(),
  })
  .strict();

export const awardSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    name: text(300).min(1, '奖项名称不能为空'),
    date: partialDateSchema.nullable(),
    issuer: nullableText(200),
    description: nullableText(),
  })
  .strict();

export const publicationSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    name: text(500).min(1, '论文或专著名称不能为空'),
    publishedAt: partialDateSchema.nullable(),
    description: nullableText(),
  })
  .strict();

export const certificateSchema = z
  .object({
    id: idSchema,
    primary: z.boolean().optional(),
    name: text(300).min(1, '证书名称不能为空'),
    obtainedAt: partialDateSchema.nullable(),
    description: nullableText(),
  })
  .strict();

function atMostOnePrimary<T extends { primary?: boolean }>(label: string) {
  return (records: T[], ctx: z.RefinementCtx) => {
    if (records.filter((record) => record.primary === true).length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}只能设定一条默认记录` });
    }
  };
}

const repeated = <T extends z.ZodTypeAny>(schema: T, label: string) =>
  listOf(schema, label).superRefine(uniqueIds(label)).superRefine(atMostOnePrimary(label));

export const profileDataSchema = z
  .object({
    personal: z
      .object({
        fullName: text(100).min(1, '姓名不能为空'),
        englishName: nullableText(100),
        email: email.nullable(),
        phone: phone.nullable(),
        birthDate: partialDateSchema.nullable(),
        currentCity: nullableText(100),
        nativePlace: nullableText(100).optional(),
        homepage: httpUrl.nullable(),
        github: httpUrl.nullable(),
        gender: genderSchema.nullable().optional(),
        workExperience: nullableText(50).optional(),
        recentCompany: nullableText(200).optional(),
        nationality: nullableText(100).optional(),
        wechat: nullableText(100).optional(),
        identityNumber: nullableText(100).optional(),
        emergencyContactName: nullableText(100).optional(),
        emergencyContactPhone: nullableText(50).optional(),
        emergencyContactRelation: nullableText(50).optional(),
      })
      .strict(),
    preferences: z
      .object({
        targetRoles: z.array(text(100)).max(20),
        preferredCities: z.array(text(100)).max(20),
        availabilityText: nullableText(200),
        internshipMonths: z.number().int().min(0).max(120).nullable(),
        daysPerWeek: z.number().int().min(1).max(7).nullable(),
        acceptsRelocation: z.boolean().nullable(),
        primaryPreferredCity: nullableText(100).optional(),
        currentSalary: nullableText(100).optional(),
        expectedSalary: nullableText(100).optional(),
        developmentLanguages: z.array(text(100)).max(20).optional(),
      })
      .strict()
      .superRefine((preferences, ctx) => {
        if (preferences.primaryPreferredCity && !preferences.preferredCities.includes(preferences.primaryPreferredCity)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['primaryPreferredCity'],
            message: '默认意向城市必须同时出现在意向城市列表中',
          });
        }
      }),
    education: repeated(educationSchema, '教育经历'),
    workExperiences: repeated(workExperienceSchema, '工作经历').optional(),
    internships: repeated(internshipSchema, '实习经历'),
    projects: repeated(projectSchema, '项目经历'),
    languages: repeated(languageSchema, '语言能力'),
    awards: repeated(awardSchema, '获奖经历').optional(),
    publications: repeated(publicationSchema, '论文或专著').optional(),
    certificates: repeated(certificateSchema, '证书').optional(),
    selfIntroduction: nullableText(),
  })
  .strict();

export const profileFileSchema = z
  .object({
    kind: z.literal('applykit-profile'),
    schemaVersion: z.literal(1, { errorMap: () => ({ message: '不支持的 schemaVersion，仅支持 1' }) }),
    profileId: idSchema,
    profileVersionId: idSchema,
    name: text(200).min(1),
    createdAt: isoDateTime,
    source: z
      .object({
        type: z.enum(['demo', 'manual', 'import']),
        status: z.enum(['fictional', 'user-reviewed']),
        note: nullableText(500),
      })
      .strict(),
    data: profileDataSchema,
  })
  .strict();

export const applicationStatusSchema = z.enum([
  'planned', 'filling', 'ready', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'closed',
]);
export const blockerSchema = z.enum(['none', 'missing_information', 'site_restriction']);

export const submissionEvidenceSchema = z
  .object({
    kind: z.enum(['user-confirmed', 'imported']),
    confirmedAt: isoDateTime,
    successSeen: z.literal(true),
    note: nullableText(500),
  })
  .strict();

export const timelineEventSchema = z
  .object({
    at: isoDateTime,
    from: applicationStatusSchema.nullable(),
    to: applicationStatusSchema,
    reason: nullableText(300),
  })
  .strict();

export const applicationRecordBaseSchema = z
  .object({
    id: idSchema,
    company: text(200).min(1, '公司不能为空'),
    role: text(200).min(1, '岗位不能为空'),
    location: nullableText(120),
    sourceUrl: httpUrl.nullable(),
    canonicalUrl: httpUrl.nullable(),
    externalJobId: nullableText(200),
    dedupeKey: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'dedupeKey 必须是 sha256:<64 位十六进制>'),
    profileVersionId: idSchema.nullable(),
    status: applicationStatusSchema,
    blocker: blockerSchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    appliedAt: isoDateTime.nullable(),
    nextAction: nullableText(500),
    notes: nullableText(),
    submissionEvidence: submissionEvidenceSchema.nullable(),
    timeline: z.array(timelineEventSchema).max(200),
  })
  .strict();

export const applicationRecordSchema = applicationRecordBaseSchema
  .superRefine((record, ctx) => {
    const submitted = ['applied', 'assessment', 'interview', 'offer', 'rejected'];
    if (submitted.includes(record.status)) {
      if (!record.appliedAt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appliedAt'], message: `状态 ${record.status} 需要 appliedAt` });
      }
      if (!record.submissionEvidence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['submissionEvidence'],
          message: `状态 ${record.status} 需要提交证据`,
        });
      }
    }
  });

export const applicationsFileSchema = z
  .object({
    kind: z.literal('applykit-applications'),
    schemaVersion: z.literal(1, { errorMap: () => ({ message: '不支持的 schemaVersion，仅支持 1' }) }),
    exportedAt: isoDateTime,
    records: z.array(applicationRecordSchema).max(5000),
  })
  .strict();

export const sectionKindSchema = z.enum([
  'personal', 'preferences', 'education', 'workExperiences', 'internships', 'projects', 'languages', 'awards', 'publications', 'certificates', 'selfIntroduction', 'unknown',
]);
export const knownSectionSchema = z.enum([
  'personal', 'preferences', 'education', 'workExperiences', 'internships', 'projects', 'languages', 'awards', 'publications', 'certificates', 'selfIntroduction',
]);
export const controlKindSchema = z.enum([
  'text', 'textarea', 'select', 'radio', 'checkbox', 'date', 'month', 'date-picker', 'combobox', 'unsupported',
]);

export const fieldRefSchema = z
  .object({
    section: knownSectionSchema,
    recordId: idSchema.optional(),
    field: z.string().min(1).max(60).regex(/^[A-Za-z][A-Za-z0-9]*$/, '字段名只允许字母与数字'),
  })
  .strict();

export const recordSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single') }).strict(),
  z.object({ kind: z.literal('degree'), level: degreeLevelSchema }).strict(),
  z.object({ kind: z.literal('record'), profileId: idSchema, recordId: idSchema }).strict(),
]);

export const savedMappingSchema = z
  .object({
    id: idSchema,
    origin: z.string().min(1).max(300),
    routeKey: z.string().max(500),
    formFingerprint: z.string().min(1).max(200),
    section: sectionKindSchema,
    fieldLabel: text(300),
    controlKind: controlKindSchema,
    fieldFingerprint: z.string().min(1).max(200),
    sourceField: z.string().min(1).max(60),
    recordSelector: recordSelectorSchema,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    lastVerifiedAt: isoDateTime,
  })
  .strict();

export const fieldResultSchema = z
  .object({
    fieldId: z.string().min(1).max(120),
    section: sectionKindSchema,
    source: fieldRefSchema.nullable(),
    outcome: z.enum(['ready', 'filled', 'unchanged', 'preserved', 'pending', 'failed']),
    reasonCode: z.enum([
      'READY_TO_FILL', 'FILLED_VERIFIED', 'VALUE_ALREADY_EQUAL', 'EXISTING_VALUE', 'SOURCE_MISSING',
      'AMBIGUOUS_FIELD', 'AMBIGUOUS_RECORD', 'AMBIGUOUS_OPTION', 'UNSUPPORTED_WIDGET',
      'PRECISION_MISMATCH', 'TEXT_TOO_LONG', 'REQUIRES_USER_ACTION', 'STALE_PAGE',
      'VALIDATION_FAILED', 'TIMEOUT', 'USER_CANCELLED', 'NO_MATCH', 'RULE_STALE',
    ]),
    label: text(300),
    elapsedMs: z.number().int().min(0),
  })
  .strict();

export const runReportSchema = z
  .object({
    id: idSchema,
    profileVersionId: idSchema,
    applicationId: idSchema.nullable(),
    origin: z.string().max(300),
    routeKey: z.string().max(500),
    phase: z.enum(['scanning', 'planned', 'filling', 'completed', 'cancelled', 'interrupted', 'failed']),
    startedAt: isoDateTime,
    finishedAt: isoDateTime.nullable(),
    modelCalls: z.literal(0),
    fields: z.array(fieldResultSchema).max(400),
  })
  .strict();

export const appStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(0),
    activeProfileVersionId: idSchema.nullable(),
    profiles: z.array(profileFileSchema).max(200),
    applications: z.array(applicationRecordSchema).max(5000),
    mappings: z.array(savedMappingSchema).max(2000),
    recentRuns: z.array(runReportSchema).max(50),
    processedMutations: z
      .array(z.object({ requestId: z.string().max(120), revision: z.number().int().min(0) }).strict())
      .max(100),
    settings: z.object({ timezone: z.string().min(1).max(80) }).strict(),
  })
  .strict();

export const backupFileSchema = z
  .object({
    kind: z.literal('applykit-backup'),
    schemaVersion: z.literal(1, { errorMap: () => ({ message: '不支持的 schemaVersion，仅支持 1' }) }),
    exportedAt: isoDateTime,
    state: appStateSchema,
  })
  .strict();

export interface ParseFailure {
  ok: false;
  errors: Array<{ path: string; message: string }>;
}
export type ParseResult<T> = { ok: true; value: T } | ParseFailure;

export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 30).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(根)',
    message: issue.message,
  }));
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}

/** 先识别 kind，再按对应 schema 校验，避免把记录文件当履历导入。 */
export type ImportKind = 'applykit-profile' | 'applykit-applications' | 'applykit-backup';

export function detectKind(input: unknown): ImportKind | null {
  if (!input || typeof input !== 'object') return null;
  const kind = (input as { kind?: unknown }).kind;
  if (kind === 'applykit-profile' || kind === 'applykit-applications' || kind === 'applykit-backup') return kind;
  return null;
}

export function parseImportText(raw: string, expected: ImportKind): ParseResult<unknown> {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > MAX_IMPORT_BYTES) {
    return { ok: false, errors: [{ path: '(文件)', message: `文件 ${(bytes / 1024 / 1024).toFixed(2)} MiB 超过 2 MiB 上限` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [{ path: '(文件)', message: `JSON 解析失败：${(error as Error).message}` }] };
  }
  const kind = detectKind(parsed);
  if (kind === null) {
    return { ok: false, errors: [{ path: 'kind', message: '缺少或无法识别 kind 字段' }] };
  }
  if (kind !== expected) {
    return { ok: false, errors: [{ path: 'kind', message: `这是 ${kind} 文件，当前入口需要 ${expected}` }] };
  }
  switch (expected) {
    case 'applykit-profile':
      return parseWith(profileFileSchema, parsed);
    case 'applykit-applications':
      return parseWith(applicationsFileSchema, parsed);
    case 'applykit-backup':
      return parseWith(backupFileSchema, parsed);
  }
}
