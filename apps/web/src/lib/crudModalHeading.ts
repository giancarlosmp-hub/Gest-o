export type CrudModalHeadingTexts = {
  createTitle: string;
  createSubtitle: string;
  editTitle: string;
  editSubtitle: string;
};

// Título e subtítulo do modal de cadastro do CrudSimplePage: com um registro em edição, os textos de edição.
export const crudModalHeading = (editingId: string | null, texts: CrudModalHeadingTexts) =>
  editingId
    ? { title: texts.editTitle, subtitle: texts.editSubtitle }
    : { title: texts.createTitle, subtitle: texts.createSubtitle };
