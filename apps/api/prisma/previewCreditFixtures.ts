// Clientes fictícios do preview para testar a faixa de crédito (creditAlert), um por nível.
// Só chaves da lista de permitidos, mais LIMITE_CREDITO de propósito no financialProfile:
// ela existe no banco do preview e não pode chegar à tela.

export type PreviewCreditLevel = "ok" | "atencao" | "risco";

export type PreviewCreditClientFixture = {
  level: PreviewCreditLevel;
  code: string;
  sellerEmail: string;
  name: string;
  city: string;
  state: string;
  region: string;
  opportunityTitle: string;
  financialProfile: Record<string, string | number>;
  partnerTitles: Array<Record<string, string | number>>;
  openTitlesTotal: number;
  overdueTitlesTotal: number;
};

export const PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY = "LIMITE_CREDITO";

const isoDaysFrom = (now: Date, days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

export const buildPreviewCreditClientFixtures = (now: Date): PreviewCreditClientFixture[] => [
  {
    level: "ok",
    code: "CRED-OK-PREVIEW",
    sellerEmail: "carla.preview@preview.local",
    name: "Crédito OK Fazenda Pontual",
    city: "Dourados",
    state: "MS",
    region: "Centro-Oeste",
    opportunityTitle: "Crédito ok - renovação de sementes",
    financialProfile: {
      DIAS_MEDIAATRASO: 0,
      DIAS_MAIORATRASO_AB: 0,
      QTD_CHEQUES_DEV: 0,
      VALOR_MEDIO: 18500,
      DATA_PRIMFATURA: isoDaysFrom(now, -2200),
      DATA_ULTFATURA: isoDaysFrom(now, -20),
      VALOR_ULTFATURA: 21400,
      [PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY]: 150000
    },
    partnerTitles: [
      { DOCTO: 910001, PARCELA: "1/2", DATA_VENCIMENTO: isoDaysFrom(now, 20), DSCFORMA: "BOLETO", VALOR: 6400, SALDO_CAPITAL: 3200 }
    ],
    openTitlesTotal: 3200,
    overdueTitlesTotal: 0
  },
  {
    level: "atencao",
    code: "CRED-ATENCAO-PREVIEW",
    sellerEmail: "bruno.preview@preview.local",
    name: "Crédito Atenção Sítio Moderado",
    city: "Chapecó",
    state: "SC",
    region: "Sul",
    opportunityTitle: "Crédito atenção - fertilizantes safra",
    financialProfile: {
      // Faixa amarela da regra: atraso médio entre 1 e 15 dias, sem atraso em aberto nem cheque.
      DIAS_MEDIAATRASO: 8,
      DIAS_MAIORATRASO_AB: 0,
      QTD_CHEQUES_DEV: 0,
      VALOR_MEDIO: 9200,
      DATA_PRIMFATURA: isoDaysFrom(now, -1500),
      DATA_ULTFATURA: isoDaysFrom(now, -45),
      VALOR_ULTFATURA: 7800,
      [PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY]: 60000
    },
    partnerTitles: [
      { DOCTO: 920001, PARCELA: "1/1", DATA_VENCIMENTO: isoDaysFrom(now, 10), DSCFORMA: "BOLETO", VALOR: 5800, SALDO_CAPITAL: 5800 }
    ],
    openTitlesTotal: 5800,
    overdueTitlesTotal: 0
  },
  {
    level: "risco",
    code: "CRED-RISCO-PREVIEW",
    sellerEmail: "ana.preview@preview.local",
    name: "Crédito Risco Agro Atrasada",
    city: "Cascavel",
    state: "PR",
    region: "Sul",
    opportunityTitle: "Crédito risco - defensivos a prazo",
    financialProfile: {
      DIAS_MEDIAATRASO: 22,
      DIAS_MAIORATRASO_AB: 35,
      QTD_CHEQUES_DEV: 1,
      VALOR_MEDIO: 12700,
      DATA_PRIMFATURA: isoDaysFrom(now, -1800),
      DATA_ULTFATURA: isoDaysFrom(now, -60),
      VALOR_ULTFATURA: 11300,
      [PREVIEW_CREDIT_OUT_OF_ALLOWLIST_KEY]: 40000
    },
    // 2 títulos vencidos (R$ 2.500,00 + R$ 1.850,00 = R$ 4.350,00) e 1 a vencer.
    partnerTitles: [
      { DOCTO: 930001, PARCELA: "1/3", DATA_VENCIMENTO: isoDaysFrom(now, -35), DSCFORMA: "BOLETO", VALOR: 2500, SALDO_CAPITAL: 2500 },
      { DOCTO: 930001, PARCELA: "2/3", DATA_VENCIMENTO: isoDaysFrom(now, -12), DSCFORMA: "BOLETO", VALOR: 2500, SALDO_CAPITAL: 1850 },
      { DOCTO: 930001, PARCELA: "3/3", DATA_VENCIMENTO: isoDaysFrom(now, 15), DSCFORMA: "BOLETO", VALOR: 3000, SALDO_CAPITAL: 3000 }
    ],
    openTitlesTotal: 7350,
    overdueTitlesTotal: 4350
  }
];
