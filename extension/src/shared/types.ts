/** 全局类型合同。持久化、消息与内容脚本都以本文件为准。 */

export type PartialDate = { year: number; month?: number; day?: number };
export type EndDate = PartialDate | { present: true };
export type DegreeLevel = 'bachelor' | 'master' | 'doctor' | 'associate' | 'other';
export type Gender = 'male' | 'female' | 'other';

export interface EducationRecord {
  id: string;
  /** 多条记录只容纳一条时优先使用；同一分区最多一条。 */
  primary?: boolean;
  school: string;
  department: string | null;
  degreeLevel: DegreeLevel;
  enrollmentStatus: 'enrolled' | 'graduated' | null;
  major: string | null;
  startDate: PartialDate | null;
  endDate: PartialDate | null;
  gpa: string | null;
  gpaScale: string | null;
  description: string | null;
  educationType?: 'fullTimeUnified' | 'fullTime' | 'partTime' | 'other' | null;
  majorRanking?: string | null;
  lab?: string | null;
  researchDirection?: string | null;
  advisor?: string | null;
  advisorResearchDirection?: string | null;
  /** 学校分配的学籍编号；各学历记录分别保存，未知时留空。 */
  studentNumber?: string | null;
}

export interface InternshipRecord {
  id: string;
  primary?: boolean;
  company: string;
  department: string | null;
  title: string | null;
  city: string | null;
  startDate: PartialDate | null;
  endDate: EndDate | null;
  description: string | null;
}

export interface ProjectRecord {
  id: string;
  primary?: boolean;
  name: string;
  role: string | null;
  startDate: PartialDate | null;
  endDate: EndDate | null;
  url: string | null;
  description: string | null;
}

export interface LanguageRecord {
  id: string;
  primary?: boolean;
  language: string;
  certificate: string | null;
  score: string | null;
  examDate: PartialDate | null;
  proficiency?: string | null;
  listeningSpeaking?: string | null;
  readingWriting?: string | null;
}

export interface WorkExperienceRecord {
  id: string;
  primary?: boolean;
  company: string;
  department: string | null;
  title: string | null;
  city: string | null;
  startDate: PartialDate | null;
  endDate: EndDate | null;
  description: string | null;
}

export interface AwardRecord {
  id: string;
  primary?: boolean;
  name: string;
  date: PartialDate | null;
  issuer: string | null;
  description: string | null;
}

export interface PublicationRecord {
  id: string;
  primary?: boolean;
  name: string;
  publishedAt: PartialDate | null;
  description: string | null;
}

export interface CertificateRecord {
  id: string;
  primary?: boolean;
  name: string;
  obtainedAt: PartialDate | null;
  description: string | null;
}

export interface ProfileData {
  personal: {
    fullName: string;
    englishName: string | null;
    email: string | null;
    phone: string | null;
    birthDate: PartialDate | null;
    currentCity: string | null;
    /** 籍贯按用户确认的行政区保存，可比网站支持的粒度更详细。 */
    nativePlace?: string | null;
    homepage: string | null;
    github: string | null;
    gender?: Gender | null;
    /** 保存招聘网站使用的明确选项，例如「在校生」「应届毕业生」「3 年」。 */
    workExperience?: string | null;
    recentCompany?: string | null;
    nationality?: string | null;
    wechat?: string | null;
    /** 用户主动保存的证件号码；只允许经过站点适配器明确绑定的字段读取。 */
    identityNumber?: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
    emergencyContactRelation?: string | null;
  };
  preferences: {
    targetRoles: string[];
    preferredCities: string[];
    availabilityText: string | null;
    internshipMonths: number | null;
    daysPerWeek: number | null;
    acceptsRelocation: boolean | null;
    /** 单选城市字段使用；为空时把 preferredCities 第一项视为最高优先级。 */
    primaryPreferredCity?: string | null;
    currentSalary?: string | null;
    expectedSalary?: string | null;
    developmentLanguages?: string[];
  };
  education: EducationRecord[];
  workExperiences?: WorkExperienceRecord[];
  internships: InternshipRecord[];
  projects: ProjectRecord[];
  languages: LanguageRecord[];
  awards?: AwardRecord[];
  publications?: PublicationRecord[];
  certificates?: CertificateRecord[];
  selfIntroduction: string | null;
}

export interface ProfileFile {
  kind: 'applykit-profile';
  schemaVersion: 1;
  profileId: string;
  profileVersionId: string;
  name: string;
  createdAt: string;
  source: {
    type: 'demo' | 'manual' | 'import';
    status: 'fictional' | 'user-reviewed';
    note: string | null;
  };
  data: ProfileData;
}

export type ApplicationStatus =
  | 'planned' | 'filling' | 'ready' | 'applied'
  | 'assessment' | 'interview' | 'offer' | 'rejected' | 'closed';
export type Blocker = 'none' | 'missing_information' | 'site_restriction';

export interface TimelineEvent {
  at: string;
  from: ApplicationStatus | null;
  to: ApplicationStatus;
  reason: string | null;
}

export interface SubmissionEvidence {
  kind: 'user-confirmed' | 'imported';
  confirmedAt: string;
  successSeen: true;
  note: string | null;
}

export interface ApplicationRecord {
  id: string;
  company: string;
  role: string;
  location: string | null;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  externalJobId: string | null;
  dedupeKey: string;
  profileVersionId: string | null;
  status: ApplicationStatus;
  blocker: Blocker;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  nextAction: string | null;
  notes: string | null;
  submissionEvidence: SubmissionEvidence | null;
  timeline: TimelineEvent[];
}

export interface ApplicationsFile {
  kind: 'applykit-applications';
  schemaVersion: 1;
  exportedAt: string;
  records: ApplicationRecord[];
}

export type SectionKind = 'personal' | 'preferences' | 'education' | 'workExperiences' |
  'internships' | 'projects' | 'languages' | 'awards' | 'publications' | 'certificates' |
  'selfIntroduction' | 'unknown';

export type KnownSection = Exclude<SectionKind, 'unknown'>;

export interface FieldRef {
  section: KnownSection;
  recordId?: string;
  field: string;
}

export type ControlKind = 'text' | 'textarea' | 'select' | 'radio' |
  'checkbox' | 'date' | 'month' | 'date-picker' | 'combobox' | 'unsupported';

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldDescriptor {
  fieldId: string;
  section: SectionKind;
  sectionInstanceId: string;
  recordInstanceId: string | null;
  label: string;
  normalizedLabel: string;
  nameHint: string | null;
  placeholderHint: string | null;
  controlKind: ControlKind;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  empty: boolean;
  maxLength: number | null;
  options: FieldOption[];
  semanticFingerprint: string;
  /** 分拆年/月控件的角色：同一经历的 start/end + year/month 组合。 */
  datePart: DatePart | null;
  /** 适配器确认的自定义日期选择器精度。 */
  datePrecision: 'year' | 'month' | 'day' | null;
  /** 日期选择器能确定性表达进行中状态时，保存其页面文案。 */
  datePresentValue: string | null;
  /** 页面明确标注的学历层级，用于重复经历绑定。 */
  degreeHint: DegreeLevel | null;
  /** 页面已存在的记录身份文本（学校名/项目名），仅用于本轮绑定。 */
  recordIdentityHint: string | null;
  /** 不能自动处理时的具体原因，用于给用户看得懂的说明。 */
  unsupportedReason: string | null;
  /** 敏感信息字段：默认不自动填写；只有本地白名单字段可由精确站点适配器使用。 */
  sensitive: boolean;
}

export interface DatePart {
  edge: 'start' | 'end' | 'single';
  unit: 'year' | 'month';
}

export type MatchReason =
  | 'user-rule'
  | 'site-adapter'
  | 'section-alias'
  | 'placeholder-hint'
  | 'name-hint'
  | 'manual-binding';

export interface MatchCandidate {
  source: FieldRef;
  score: number;
  reasons: MatchReason[];
}

export type FillOutcome = 'ready' | 'filled' | 'unchanged' | 'preserved' | 'pending' | 'failed';

export type ReasonCode =
  | 'READY_TO_FILL' | 'FILLED_VERIFIED' | 'VALUE_ALREADY_EQUAL' | 'EXISTING_VALUE' | 'SOURCE_MISSING'
  | 'AMBIGUOUS_FIELD' | 'AMBIGUOUS_RECORD' | 'AMBIGUOUS_OPTION' | 'UNSUPPORTED_WIDGET'
  | 'PRECISION_MISMATCH' | 'TEXT_TOO_LONG' | 'REQUIRES_USER_ACTION' | 'STALE_PAGE'
  | 'VALIDATION_FAILED' | 'TIMEOUT' | 'USER_CANCELLED' | 'NO_MATCH' | 'RULE_STALE';

export interface FillAction {
  fieldId: string;
  source: FieldRef;
  expectedFingerprint: string;
  kind: ControlKind;
  value: string | boolean | string[];
  overwrite: false | 'user-approved';
}

export interface FieldResult {
  fieldId: string;
  section: SectionKind;
  source: FieldRef | null;
  outcome: FillOutcome;
  reasonCode: ReasonCode;
  label: string;
  elapsedMs: number;
}

export type RunPhase = 'scanning' | 'planned' | 'filling' | 'completed' |
  'cancelled' | 'interrupted' | 'failed';

export interface RunReport {
  id: string;
  profileVersionId: string;
  applicationId: string | null;
  origin: string;
  routeKey: string;
  phase: RunPhase;
  startedAt: string;
  finishedAt: string | null;
  modelCalls: 0;
  fields: FieldResult[];
}

export type RecordSelector =
  | { kind: 'single' }
  | { kind: 'degree'; level: DegreeLevel }
  | { kind: 'record'; profileId: string; recordId: string };

export interface SavedMapping {
  id: string;
  origin: string;
  routeKey: string;
  formFingerprint: string;
  section: SectionKind;
  fieldLabel: string;
  controlKind: ControlKind;
  fieldFingerprint: string;
  sourceField: string;
  recordSelector: RecordSelector;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string;
}

export interface AppSettings {
  timezone: string;
}

/**
 * jobprep：你在网申页上手动补填、履历里没有的内容（性别、婚姻状况、学历类型…），
 * 经你勾选后记住，下次任何网站上同名字段就能自动填。单独存一个 storage 键，不进 AppState 和备份。
 */
export interface RememberedAnswer {
  id: string;
  section: KnownSection;
  label: string; // 规范化后的字段名，用来匹配
  displayLabel: string;
  /** 经历类字段（例如某段教育的「学历类型」）属于哪段经历：学校 / 公司 / 项目名；个人字段为 null */
  recordKey: string | null;
  value: string;
  savedAt: string;
  origin: string; // 在哪个网站记下的，只用于展示
}

export interface AppState {
  schemaVersion: 1;
  revision: number;
  activeProfileVersionId: string | null;
  profiles: ProfileFile[];
  applications: ApplicationRecord[];
  mappings: SavedMapping[];
  recentRuns: RunReport[];
  processedMutations: Array<{ requestId: string; revision: number }>;
  settings: AppSettings;
}

export interface BackupFile {
  kind: 'applykit-backup';
  schemaVersion: 1;
  exportedAt: string;
  state: AppState;
}

export interface JobCandidate {
  company: string | null;
  role: string | null;
  location: string | null;
  externalJobId: string | null;
  sourceUrl: string | null;
  evidence: 'json-ld' | 'adapter' | 'heuristic';
}

export interface ActiveRunMeta {
  runId: string;
  tabId: number;
  documentId: string;
  nonce: string;
  lastSeq: number;
  lastSeenAt: string;
  planRevision: number;
}
