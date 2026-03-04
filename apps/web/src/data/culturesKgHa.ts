export type CultureKgHa = {
  id: string;
  name: string;
  group: string;
  kgHaMin: number | null;
  kgHaMax: number | null;
  defaultPureza?: number;
  defaultGerminacao?: number;
  notes?: string;
  active: boolean;
};

export const culturesKgHa: CultureKgHa[] = [
  { id: "soja", name: "Soja", group: "Grãos", kgHaMin: 45, kgHaMax: 65, defaultPureza: 99, defaultGerminacao: 90, notes: "Ajustar conforme PMS, vigor e espaçamento.", active: true },
  { id: "milho", name: "Milho", group: "Grãos", kgHaMin: 18, kgHaMax: 28, defaultPureza: 98, defaultGerminacao: 92, notes: "Faixa de referência para híbridos comerciais.", active: true },
  { id: "sorgo", name: "Sorgo", group: "Grãos", kgHaMin: 10, kgHaMax: 18, defaultPureza: 98, defaultGerminacao: 85, notes: "Pode variar por finalidade: grão, silagem ou cobertura.", active: true },
  { id: "braquiaria", name: "Braquiária", group: "Forrageiras", kgHaMin: 6, kgHaMax: 12, defaultPureza: 60, defaultGerminacao: 70, notes: "Considerar VC (valor cultural) e forma de semeadura.", active: true },
  { id: "panicum", name: "Panicum", group: "Forrageiras", kgHaMin: 4, kgHaMax: 8, defaultPureza: 55, defaultGerminacao: 68, notes: "Sementes pequenas exigem regulagem fina da distribuição.", active: true },
  { id: "crotalaria", name: "Crotalária", group: "Cobertura", kgHaMin: 12, kgHaMax: 20, defaultPureza: 97, defaultGerminacao: 85, notes: "Boa opção para cobertura e aporte de biomassa.", active: true },
  { id: "nabo-forrageiro", name: "Nabo forrageiro", group: "Cobertura", kgHaMin: 8, kgHaMax: 14, defaultPureza: 97, defaultGerminacao: 86, notes: "Dose depende do arranjo e do mix de cobertura.", active: true },
  { id: "aveia-preta", name: "Aveia preta", group: "Cobertura", kgHaMin: 40, kgHaMax: 60, defaultPureza: 98, defaultGerminacao: 80, notes: "Pode exigir ajuste em semeadura a lanço.", active: true },
];
