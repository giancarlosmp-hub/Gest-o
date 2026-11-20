/**
 * Manutenção: grava no Catálogo Técnico (CultureCatalog) os dados com fonte de
 * src/scripts/data/technicalCatalog.json.
 *
 * Regras:
 *   - upsert por slug; só culturas que estão no arquivo são lidas ou gravadas;
 *   - nunca apaga cultura e nunca muda isActive de cultura existente (cultura nova nasce ativa);
 *   - grava label, category, kg/ha mín./máx., população, espaçamento, PMS, germinação, pureza,
 *     observações (notes) e faixas por objetivo (goalsJson); campo null no arquivo apaga o valor;
 *   - todo número do arquivo tem fonte; campo vazio tem motivo (o arquivo é recusado sem isso);
 *   - campo marcado "manter" (valor anterior plausível, sem fonte confirmada) não é gravado: fica o
 *     valor que já está no banco. O "value" dele é o valor anterior conhecido, usado só na revisão, e
 *     as observações da cultura precisam dizer "valor anterior, sem fonte confirmada". O mesmo vale
 *     para objetivos em "manterObjetivos" dentro de goalsJson.
 *
 * Uso no container da API (compilado em dist/scripts). O tsc não copia o .json para dist: passe o
 * arquivo com --file (o padrão é o caminho ao lado deste script, que vale ao rodar com tsx).
 *   node dist/scripts/importTechnicalCatalog.js --file=<catalogo.json>                 (simulação, READ ONLY)
 *   node dist/scripts/importTechnicalCatalog.js --file=<catalogo.json> --apply --expect=N --backup-dir=<dir>
 *   node dist/scripts/importTechnicalCatalog.js --restore=<backup.json>                (simulação da restauração)
 *   node dist/scripts/importTechnicalCatalog.js --restore=<backup.json> --apply
 *   node dist/scripts/importTechnicalCatalog.js --file=<catalogo.json> --review        (revisão do arquivo, sem banco)
 *
 * N do --expect = culturas a criar + culturas a atualizar (o que a simulação mostra).
 * O backup (JSON, permissão 600) com os valores antigos é gravado antes de gravar, na mesma transação;
 * se falhar, nada é gravado. A restauração devolve os valores antigos só se a cultura ainda estiver
 * exatamente como o import deixou; cultura criada pelo import é desativada (não apagada).
 * Imports: @prisma/client, @salesforce-pro/shared e módulos do Node (teste de contrato em
 * importTechnicalCatalog.test.ts). A saída traz slugs, nomes de campo e contagens, nunca os textos.
 */
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { cultureCatalogSchema } from "@salesforce-pro/shared";

export const CATALOG_FORMAT = "technicalCatalog/v1";
export const BACKUP_FORMAT = "importTechnicalCatalog/v1";
export const ALLOWED_CATEGORIES = ["Grãos", "Cobertura", "Leguminosas", "Forrageiras"] as const;
export const NUMERIC_FIELDS = [
  "defaultKgHaMin",
  "defaultKgHaMax",
  "populationTargetDefault",
  "rowSpacingCmDefault",
  "pmsDefault",
  "germinationDefault",
  "purityDefault",
] as const;
export const WRITTEN_FIELDS = ["label", "category", ...NUMERIC_FIELDS, "notes", "goalsJson"] as const;
export const DEFAULT_CATALOG_FILE = fileURLToPath(new URL("./data/technicalCatalog.json", import.meta.url));

type NumericField = (typeof NUMERIC_FIELDS)[number];
export type WrittenField = (typeof WRITTEN_FIELDS)[number];
export type GoalRanges = Record<string, { min: number; max: number }>;

export type CulturePayload = {
  slug: string;
  label: string;
  category: string;
  defaultKgHaMin: number | null;
  defaultKgHaMax: number | null;
  populationTargetDefault: number | null;
  rowSpacingCmDefault: number | null;
  pmsDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  notes: string | null;
  goalsJson: GoalRanges;
};

/** Cultura lida do arquivo: o payload (com os valores anteriores nos campos mantidos) e o que é mantido. */
export type CatalogEntry = CulturePayload & {
  /** Campos numéricos que o import não grava (fica o valor do banco). */
  kept: NumericField[];
  /** Objetivos de goalsJson que o import não grava (fica a faixa do banco, se houver). */
  keptGoals: string[];
};

export const KEPT_NOTE = "valor anterior, sem fonte confirmada";

type SourcedValue = { value: unknown; sources?: unknown; detail?: unknown; reason?: unknown; manter?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const GOAL_KEY = /^[a-z0-9_-]+$/;

function parseGoalRanges(slug: string, raw: Record<string, unknown>): GoalRanges {
  const goals: GoalRanges = {};
  for (const [key, range] of Object.entries(raw)) {
    if (!GOAL_KEY.test(key)) throw new Error(`${slug}: objetivo com chave fora do padrão (${key}).`);
    if (!isRecord(range) || typeof range.min !== "number" || typeof range.max !== "number" || range.min < 0 || range.max < range.min) {
      throw new Error(`${slug}: faixa inválida no objetivo ${key}.`);
    }
    goals[key] = { min: range.min, max: range.max };
  }
  return goals;
}

/**
 * Confere um campo: com valor, exige fonte(s) existente(s) e detalhe; vazio, exige motivo; mantido
 * (manter: true), exige o valor anterior e o motivo, sem fonte.
 */
function checkSourced(slug: string, field: string, raw: unknown, sourceIds: Set<string>): SourcedValue {
  if (!isRecord(raw) || !("value" in raw)) throw new Error(`${slug}: campo ${field} ausente ou sem "value".`);
  const entry = raw as SourcedValue;
  if (entry.manter !== undefined) {
    if (entry.manter !== true || field === "goalsJson") throw new Error(`${slug}: campo ${field} com "manter" inválido.`);
    if (entry.value === null) throw new Error(`${slug}: campo ${field} mantido sem o valor anterior.`);
    if (entry.sources !== undefined) throw new Error(`${slug}: campo ${field} mantido não leva fonte (é valor sem fonte confirmada).`);
    if (!nonEmptyText(entry.reason)) throw new Error(`${slug}: campo ${field} mantido sem motivo.`);
    return entry;
  }
  const empty = entry.value === null || (isRecord(entry.value) && Object.keys(entry.value).length === 0);
  if (empty) {
    if (!nonEmptyText(entry.reason)) throw new Error(`${slug}: campo ${field} vazio sem motivo.`);
    return entry;
  }
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) throw new Error(`${slug}: campo ${field} com valor e sem fonte.`);
  for (const source of entry.sources) {
    if (typeof source !== "string" || !sourceIds.has(source)) throw new Error(`${slug}: campo ${field} cita fonte desconhecida.`);
  }
  if (!nonEmptyText(entry.detail)) throw new Error(`${slug}: campo ${field} sem detalhe de onde saiu o valor.`);
  return entry;
}

/** Lê e valida o arquivo de dados; devolve o que será gravado por cultura. */
export function parseCatalogFile(content: string): CatalogEntry[] {
  const catalog = JSON.parse(content) as unknown;
  if (!isRecord(catalog) || catalog.format !== CATALOG_FORMAT) throw new Error("Arquivo do catálogo em formato inesperado.");
  if (!isRecord(catalog.fontes)) throw new Error("Arquivo do catálogo sem fontes.");
  for (const [id, source] of Object.entries(catalog.fontes)) {
    if (!isRecord(source) || !nonEmptyText(source.orgao) || !nonEmptyText(source.titulo) || !nonEmptyText(source.link)) {
      throw new Error(`Fonte ${id} sem órgão, título ou link.`);
    }
    if (!(source.ano === null || (typeof source.ano === "number" && Number.isInteger(source.ano)))) throw new Error(`Fonte ${id} com ano inválido.`);
  }
  const sourceIds = new Set(Object.keys(catalog.fontes));
  if (!Array.isArray(catalog.culturas) || catalog.culturas.length === 0) throw new Error("Arquivo do catálogo sem culturas.");

  const seen = new Set<string>();
  return catalog.culturas.map((raw) => {
    if (!isRecord(raw) || !nonEmptyText(raw.slug) || !nonEmptyText(raw.label)) throw new Error("Cultura sem slug ou nome.");
    const slug = raw.slug;
    if (seen.has(slug)) throw new Error(`Slug repetido no arquivo: ${slug}.`);
    seen.add(slug);
    if (!(ALLOWED_CATEGORIES as readonly unknown[]).includes(raw.category)) throw new Error(`${slug}: categoria fora das quatro padronizadas.`);
    if (!(raw.notes === null || typeof raw.notes === "string")) throw new Error(`${slug}: observações inválidas.`);
    if (!isRecord(raw.campos)) throw new Error(`${slug}: sem campos.`);
    const campos = raw.campos;
    const known = new Set<string>([...NUMERIC_FIELDS, "goalsJson"]);
    for (const key of Object.keys(campos)) if (!known.has(key)) throw new Error(`${slug}: campo desconhecido ${key}.`);

    const numbers = {} as Record<NumericField, number | null>;
    const kept: NumericField[] = [];
    for (const field of NUMERIC_FIELDS) {
      const entry = checkSourced(slug, field, campos[field], sourceIds);
      if (!(entry.value === null || (typeof entry.value === "number" && Number.isFinite(entry.value)))) throw new Error(`${slug}: ${field} não é número.`);
      numbers[field] = entry.value as number | null;
      if (entry.manter === true) kept.push(field);
    }
    if (kept.includes("defaultKgHaMin") !== kept.includes("defaultKgHaMax")) throw new Error(`${slug}: kg/ha mínimo e máximo mantidos juntos ou nenhum.`);
    const goalsEntry = checkSourced(slug, "goalsJson", campos.goalsJson, sourceIds) as SourcedValue & { manterObjetivos?: unknown; manterMotivo?: unknown };
    if (!isRecord(goalsEntry.value)) throw new Error(`${slug}: goalsJson precisa ser um objeto.`);
    const goalsJson = parseGoalRanges(slug, goalsEntry.value);
    let keptGoals: string[] = [];
    if (goalsEntry.manterObjetivos !== undefined) {
      if (!isRecord(goalsEntry.manterObjetivos) || !Object.keys(goalsEntry.manterObjetivos).length) throw new Error(`${slug}: manterObjetivos vazio ou inválido.`);
      if (!nonEmptyText(goalsEntry.manterMotivo)) throw new Error(`${slug}: manterObjetivos sem motivo.`);
      const previousGoals = parseGoalRanges(slug, goalsEntry.manterObjetivos);
      keptGoals = Object.keys(previousGoals);
      for (const key of keptGoals) {
        if (key in goalsJson) throw new Error(`${slug}: objetivo ${key} com fonte e mantido ao mesmo tempo.`);
        goalsJson[key] = previousGoals[key];
      }
    }

    if ((numbers.defaultKgHaMin === null) !== (numbers.defaultKgHaMax === null)) throw new Error(`${slug}: kg/ha mínimo e máximo devem vir juntos.`);
    if (raw.category === "Forrageiras" && numbers.populationTargetDefault !== null) throw new Error(`${slug}: forrageira não leva população (plantas/ha).`);
    const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;
    if ((kept.length || keptGoals.length) && !notes?.includes(KEPT_NOTE)) throw new Error(`${slug}: campo mantido sem a observação "${KEPT_NOTE}".`);

    const payload: CulturePayload = {
      slug,
      label: raw.label.trim(),
      category: raw.category as string,
      ...numbers,
      notes,
      goalsJson,
    };
    // Mesma validação da tela de Configurações (shared): faixa, limites de 0 a 100 etc.
    const validated = cultureCatalogSchema.safeParse({ ...payload, isActive: true, tags: [] });
    if (!validated.success) throw new Error(`${slug}: ${validated.error.issues[0]?.message ?? "dados inválidos"}.`);
    return { ...payload, kept, keptGoals };
  });
}

// ---------------------------------------------------------------------------------------------
// Revisão automática (sem banco)

/** Conta da Recomendação de semeadura do Assistente Técnico (kg/ha), sem perda a campo. */
export function seedingKgHa(populationHa: number, pms: number, germination: number, purity: number) {
  return ((populationHa / ((germination / 100) * (purity / 100))) * pms) / 1000000;
}

export type ReviewResult = {
  conferidas: { slug: string; kgHa: number; faixa: string; dentro: boolean; objetivos: Record<string, boolean> }[];
  semConta: { slug: string; faltando: string[] }[];
  alertas: { slug: string; mensagem: string }[];
  /** Campos com valor anterior sem fonte confirmada (a revisão usa o valor anterior conhecido). */
  mantidosSemFonte: Record<string, string[]>;
};

const keptOf = (item: CulturePayload | CatalogEntry) => ("kept" in item ? item.kept : []);
const keptGoalsOf = (item: CulturePayload | CatalogEntry) => ("keptGoals" in item ? item.keptGoals : []);

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Roda a fórmula da calculadora com os padrões propostos e confere plausibilidade e unidades. */
export function reviewCatalog(payloads: CulturePayload[]): ReviewResult {
  const result: ReviewResult = { conferidas: [], semConta: [], alertas: [], mantidosSemFonte: {} };
  for (const item of payloads) {
    const alert = (mensagem: string) => result.alertas.push({ slug: item.slug, mensagem });
    const keptFields = [...keptOf(item), ...keptGoalsOf(item).map((key) => `goalsJson.${key}`)];
    if (keptFields.length) result.mantidosSemFonte[item.slug] = keptFields;
    for (const field of ["germinationDefault", "purityDefault"] as const) {
      const value = item[field];
      if (value !== null && (value <= 0 || value > 100)) alert(`${field} fora de 0–100%.`);
    }
    if (item.rowSpacingCmDefault !== null && (item.rowSpacingCmDefault < 5 || item.rowSpacingCmDefault > 150)) alert("espaçamento fora de 5–150 cm.");
    if (item.populationTargetDefault !== null && (item.populationTargetDefault < 1000 || item.populationTargetDefault > 10000000)) {
      alert("população fora de 1 mil–10 milhões de plantas/ha.");
    }
    if (item.pmsDefault !== null) {
      if (item.pmsDefault < 0.1 || item.pmsDefault > 1000) alert("PMS fora de 0,1–1.000 g.");
      if (item.category === "Forrageiras" && item.pmsDefault > 20) alert("PMS alto para forrageira (acima de 20 g).");
    }
    const ranges = [
      ...(item.defaultKgHaMin !== null && item.defaultKgHaMax !== null ? [{ min: item.defaultKgHaMin, max: item.defaultKgHaMax }] : []),
      ...Object.values(item.goalsJson),
    ];
    for (const range of ranges) if (range.max > 500) alert("faixa de kg/ha acima de 500 kg/ha.");

    const missing: string[] = (["populationTargetDefault", "pmsDefault", "germinationDefault", "purityDefault"] as const).filter((field) => item[field] === null);
    if (item.defaultKgHaMin === null && !Object.keys(item.goalsJson).length) missing.push("faixa kg/ha");
    if (missing.length) {
      result.semConta.push({ slug: item.slug, faltando: missing });
      continue;
    }
    const kgHa = round2(seedingKgHa(item.populationTargetDefault!, item.pmsDefault!, item.germinationDefault!, item.purityDefault!));
    const inside = (range: { min: number; max: number }) => kgHa >= range.min && kgHa <= range.max;
    const objetivos = Object.fromEntries(Object.entries(item.goalsJson).map(([key, range]) => [key, inside(range)]));
    const general = item.defaultKgHaMin !== null ? { min: item.defaultKgHaMin, max: item.defaultKgHaMax! } : null;
    result.conferidas.push({
      slug: item.slug,
      kgHa,
      faixa: general ? `${general.min}–${general.max}` : "—",
      dentro: general ? inside(general) : Object.values(objetivos).some(Boolean),
      objetivos,
    });
    if (general && !inside(general)) alert(`conta da calculadora (${kgHa} kg/ha) fora da faixa ${general.min}–${general.max}.`);
    for (const key of keptGoalsOf(item)) if (!objetivos[key]) alert(`conta da calculadora (${kgHa} kg/ha) fora da faixa mantida do objetivo ${key}.`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Plano (banco)

export type CatalogRow = {
  id: string;
  slug: string;
  label: string;
  category: string;
  isActive: boolean;
  defaultKgHaMin: number | null;
  defaultKgHaMax: number | null;
  populationTargetDefault: number | null;
  rowSpacingCmDefault: number | null;
  pmsDefault: number | null;
  germinationDefault: number | null;
  purityDefault: number | null;
  notes: string | null;
  goalsJson: unknown;
};
export type FieldValues = Pick<CulturePayload, WrittenField>;

export type ImportPlan = {
  toCreate: CulturePayload[];
  toUpdate: { row: CatalogRow; payload: CulturePayload; changed: WrittenField[] }[];
  unchanged: string[];
  /** Por cultura existente: valor que fica no banco em cada campo mantido (null = vazio no banco). */
  kept: Record<string, Record<string, number | { min: number; max: number } | null>>;
  /** Campos mantidos cujo valor no banco difere do valor anterior conhecido do arquivo. */
  keptDiffersFromFile: string[];
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

export const fieldValues = (source: FieldValues | CatalogRow): FieldValues =>
  Object.fromEntries(WRITTEN_FIELDS.map((field) => [field, field === "goalsJson" ? canonical(source.goalsJson ?? {}) : source[field]])) as FieldValues;

const isGoalRange = (value: unknown): value is { min: number; max: number } =>
  isRecord(value) && typeof value.min === "number" && typeof value.max === "number";

/**
 * O que de fato vai para o banco: campo mantido fica com o valor atual da linha (cultura nova: vazio);
 * objetivo mantido fica com a faixa atual da linha, se houver.
 */
export function resolvePayload(entry: CulturePayload | CatalogEntry, row: CatalogRow | undefined): CulturePayload {
  const { kept: _kept, keptGoals: _keptGoals, ...base } = entry as CatalogEntry;
  const payload: CulturePayload = { ...base, goalsJson: { ...entry.goalsJson } };
  for (const field of keptOf(entry)) payload[field] = row ? row[field] : null;
  const rowGoals = row && isRecord(row.goalsJson) ? row.goalsJson : {};
  for (const key of keptGoalsOf(entry)) {
    const current = rowGoals[key];
    if (isGoalRange(current)) payload.goalsJson[key] = { min: current.min, max: current.max };
    else delete payload.goalsJson[key];
  }
  return payload;
}

export function planImport(rows: CatalogRow[], entries: (CulturePayload | CatalogEntry)[]): ImportPlan {
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const plan: ImportPlan = { toCreate: [], toUpdate: [], unchanged: [], kept: {}, keptDiffersFromFile: [] };
  for (const entry of entries) {
    const row = bySlug.get(entry.slug);
    const payload = resolvePayload(entry, row);
    if (!row) {
      plan.toCreate.push(payload);
      continue;
    }
    const keptHere: Record<string, number | { min: number; max: number } | null> = {};
    for (const field of keptOf(entry)) {
      keptHere[field] = row[field];
      if (!sameValue(row[field], entry[field])) plan.keptDiffersFromFile.push(`${row.slug}.${field}`);
    }
    for (const key of keptGoalsOf(entry)) {
      keptHere[`goalsJson.${key}`] = payload.goalsJson[key] ?? null;
      if (!sameValue(payload.goalsJson[key], entry.goalsJson[key])) plan.keptDiffersFromFile.push(`${row.slug}.goalsJson.${key}`);
    }
    if (Object.keys(keptHere).length) plan.kept[row.slug] = keptHere;
    const changed = WRITTEN_FIELDS.filter((field) => !sameValue(row[field], payload[field]));
    if (changed.length) plan.toUpdate.push({ row, payload, changed });
    else plan.unchanged.push(payload.slug);
  }
  return plan;
}

/** Só slugs, nomes de campo e contagens. */
export function summarizePlan(plan: ImportPlan) {
  const cleared = plan.toUpdate.reduce((total, item) => total + item.changed.filter((field) => item.payload[field] === null && item.row[field] !== null).length, 0);
  return {
    criar: plan.toCreate.length,
    atualizar: plan.toUpdate.length,
    semMudanca: plan.unchanged.length,
    expect: plan.toCreate.length + plan.toUpdate.length,
    camposQueFicamVazios: cleared,
    inativasNoArquivo: plan.toUpdate.filter((item) => !item.row.isActive).length,
    novas: plan.toCreate.map((item) => item.slug),
    camposPorCultura: Object.fromEntries(plan.toUpdate.map((item) => [item.row.slug, item.changed])),
    mudancasDeCategoria: plan.toUpdate.filter((item) => item.changed.includes("category")).map((item) => item.row.slug),
    mantidosSemFonte: plan.kept,
    mantidosDiferentesDoArquivo: plan.keptDiffersFromFile,
  };
}

export type CatalogDb = {
  cultureCatalog: {
    findMany(args: unknown): Promise<CatalogRow[]>;
    create(args: unknown): Promise<{ slug: string }>;
    update(args: unknown): Promise<{ slug: string }>;
  };
};
export type TransactionRunner = <T>(fn: (tx: CatalogDb) => Promise<T>) => Promise<T>;

const ROW_SELECT = Object.fromEntries(["id", "slug", "isActive", ...WRITTEN_FIELDS].map((field) => [field, true]));

/** Lê só as culturas cujo slug está no arquivo. */
export const loadRows = (db: CatalogDb, slugs: string[]) => db.cultureCatalog.findMany({ where: { slug: { in: slugs } }, select: ROW_SELECT });

const writeData = (values: FieldValues) => ({ ...values, goalsJson: values.goalsJson as Prisma.InputJsonValue });

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  updated: { slug: string; before: FieldValues; after: FieldValues }[];
  created: { slug: string; after: FieldValues }[];
};

const writeBackupFile = (backupDir: string, backup: BackupFile) => {
  if (!statSync(backupDir).isDirectory()) throw new Error("--backup-dir não é um diretório.");
  const file = resolve(backupDir, `technical-catalog-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(backup, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const written = JSON.parse(readFileSync(file, "utf8")) as BackupFile;
  if (written.updated.length !== backup.updated.length || written.created.length !== backup.created.length) {
    throw new Error("Backup gravado não confere com o estado lido; nada foi gravado.");
  }
  return file;
};

export async function applyImport(
  runInTransaction: TransactionRunner,
  payloads: (CulturePayload | CatalogEntry)[],
  options: { expected: number; backupDir: string; now?: Date },
) {
  return runInTransaction(async (tx) => {
    const plan = planImport(await loadRows(tx, payloads.map((item) => item.slug)), payloads);
    const total = plan.toCreate.length + plan.toUpdate.length;
    if (total !== options.expected) throw new Error(`Contagem divergente; nada foi gravado. esperado=${options.expected} encontrado=${total}`);
    // Backup antes de gravar: se a gravação falhar, a exceção desfaz a transação sem gravar nada.
    const backupFile = writeBackupFile(options.backupDir, {
      format: BACKUP_FORMAT,
      createdAt: (options.now ?? new Date()).toISOString(),
      updated: plan.toUpdate.map((item) => ({ slug: item.row.slug, before: fieldValues(item.row), after: fieldValues(item.payload) })),
      created: plan.toCreate.map((item) => ({ slug: item.slug, after: fieldValues(item) })),
    });
    for (const item of plan.toUpdate) await tx.cultureCatalog.update({ where: { slug: item.row.slug }, data: writeData(fieldValues(item.payload)) });
    for (const item of plan.toCreate) {
      await tx.cultureCatalog.create({ data: { slug: item.slug, isActive: true, tags: [], ...writeData(fieldValues(item)) } });
    }
    return { summary: summarizePlan(plan), backupFile, gravadas: total };
  });
}

export function parseBackupFile(content: string): BackupFile {
  const backup = JSON.parse(content) as BackupFile;
  if (backup.format !== BACKUP_FORMAT || !Array.isArray(backup.updated) || !Array.isArray(backup.created)) throw new Error("Arquivo de backup em formato inesperado.");
  const hasAllFields = (values: unknown) => isRecord(values) && WRITTEN_FIELDS.every((field) => field in values);
  for (const item of backup.updated) if (!nonEmptyText(item.slug) || !hasAllFields(item.before) || !hasAllFields(item.after)) throw new Error("Backup incompleto.");
  for (const item of backup.created) if (!nonEmptyText(item.slug) || !hasAllFields(item.after)) throw new Error("Backup incompleto.");
  return backup;
}

/**
 * Sem `apply`, só confere e conta. Devolve os valores antigos das culturas atualizadas e desativa as
 * criadas, mas só se todas ainda estiverem exatamente como o import deixou (senão nada é gravado).
 */
export async function restoreFromBackup(runInTransaction: TransactionRunner, backup: BackupFile, apply: boolean) {
  return runInTransaction(async (tx) => {
    const slugs = [...backup.updated, ...backup.created].map((item) => item.slug);
    const rows = new Map((await loadRows(tx, slugs)).map((row) => [row.slug, row]));
    const changedSince = [...backup.updated, ...backup.created].filter((item) => {
      const row = rows.get(item.slug);
      return !row || !sameValue(fieldValues(row), item.after);
    });
    if (changedSince.length) throw new Error(`${changedSince.length} cultura(s) mudaram ou sumiram depois do import; nada foi restaurado.`);
    if (!apply) {
      return { modo: "simulação da restauração (nada foi gravado)", culturasParaVoltar: backup.updated.length, culturasParaDesativar: backup.created.length };
    }
    for (const item of backup.updated) await tx.cultureCatalog.update({ where: { slug: item.slug }, data: writeData(item.before) });
    for (const item of backup.created) await tx.cultureCatalog.update({ where: { slug: item.slug }, data: { isActive: false } });
    return { modo: "restore concluído", culturasRestauradas: backup.updated.length, culturasDesativadas: backup.created.length };
  });
}

// ---------------------------------------------------------------------------------------------
// CLI

export type CliOptions =
  | { mode: "review"; file: string }
  | { mode: "simulate"; file: string }
  | { mode: "apply"; file: string; expected: number; backupDir: string }
  | { mode: "restore"; backupFile: string; apply: boolean };

const USAGE =
  "uso: importTechnicalCatalog [--file=<catalogo.json>] [--review | --apply --expect=N --backup-dir=<dir>] | --restore=<backup.json> [--apply]";

export function parseCliArgs(args: string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--(apply|expect|backup-dir|restore|file|review)(?:=(.+))?$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error(USAGE);
    values.set(match[1], match[2] ?? true);
  }
  for (const flag of ["apply", "review"]) if (values.has(flag) && values.get(flag) !== true) throw new Error(USAGE);
  for (const option of ["expect", "backup-dir", "restore", "file"]) if (values.get(option) === true) throw new Error(USAGE);
  const file = (values.get("file") as string | undefined) ?? DEFAULT_CATALOG_FILE;
  if (values.has("restore")) {
    if (values.has("expect") || values.has("backup-dir") || values.has("file") || values.has("review")) throw new Error(USAGE);
    return { mode: "restore", backupFile: values.get("restore") as string, apply: values.has("apply") };
  }
  if (values.has("review")) {
    if (values.has("apply") || values.has("expect") || values.has("backup-dir")) throw new Error(USAGE);
    return { mode: "review", file };
  }
  if (values.has("apply")) {
    const expected = values.get("expect");
    if (typeof expected !== "string" || !/^\d+$/.test(expected)) throw new Error(`${USAGE}\n--apply exige --expect=N.`);
    const backupDir = values.get("backup-dir");
    if (typeof backupDir !== "string") throw new Error(`${USAGE}\n--apply exige --backup-dir=<dir>.`);
    return { mode: "apply", file, expected: Number(expected), backupDir };
  }
  if (values.has("expect") || values.has("backup-dir")) throw new Error(`${USAGE}\nAs opções --expect e --backup-dir só valem com --apply.`);
  return { mode: "simulate", file };
}

export type CatalogClient = {
  $transaction<T>(fn: (tx: unknown) => Promise<T>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait?: number }): Promise<T>;
  $disconnect(): Promise<void>;
};
type ReadOnlyTx = CatalogDb & { $executeRaw(query: TemplateStringsArray): Promise<number> };

/** Valida argumentos e arquivo antes de criar o client: erro nunca abre conexão; --review não abre. */
export async function runCli(args: string[], createClient: () => CatalogClient, log: (line: string) => void = console.log) {
  const options = parseCliArgs(args);
  if (options.mode === "review") {
    log(JSON.stringify({ modo: "revisão do arquivo (sem banco)", ...reviewCatalog(parseCatalogFile(readFileSync(options.file, "utf8"))) }, null, 2));
    return;
  }
  const payloads = options.mode === "restore" ? [] : parseCatalogFile(readFileSync(options.file, "utf8"));
  const backup = options.mode === "restore" ? parseBackupFile(readFileSync(options.backupFile, "utf8")) : null;
  const client = createClient();
  const runInTransaction: TransactionRunner = (fn) =>
    client.$transaction((tx) => fn(tx as CatalogDb), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 10_000 });
  // Simulações: snapshot consistente e o banco recusa qualquer escrita nesta transação.
  const runReadOnly: TransactionRunner = (fn) =>
    client.$transaction(async (tx) => {
      const readOnly = tx as ReadOnlyTx;
      await readOnly.$executeRaw`SET TRANSACTION READ ONLY`;
      return fn(readOnly);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  try {
    if (options.mode === "simulate") {
      const plan = await runReadOnly(async (tx) => planImport(await loadRows(tx, payloads.map((item) => item.slug)), payloads));
      log(JSON.stringify({ modo: "simulação (nada foi gravado)", ...summarizePlan(plan) }, null, 2));
    } else if (options.mode === "apply") {
      const result = await applyImport(runInTransaction, payloads, { expected: options.expected, backupDir: options.backupDir });
      log(JSON.stringify({ modo: "apply concluído", gravadas: result.gravadas, backup: result.backupFile, ...result.summary }, null, 2));
    } else {
      log(JSON.stringify(await restoreFromBackup(options.apply ? runInTransaction : runReadOnly, backup!, options.apply), null, 2));
    }
  } finally {
    await client.$disconnect();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2), () => new PrismaClient() as unknown as CatalogClient).catch((error) => {
    // Erros do Prisma podem citar valores das linhas: mostra só o código.
    if (error instanceof Prisma.PrismaClientKnownRequestError) console.error(`Erro do Prisma ${error.code}; nada foi gravado.`);
    else console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
