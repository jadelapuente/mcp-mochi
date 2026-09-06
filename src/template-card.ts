import { MochiError } from "./errors.js";
import type { CreateCardFromTemplateParams, Template } from "./schemas.js";

export function buildCreateCardFromTemplateRequest(
  request: CreateCardFromTemplateParams,
  template: Template
): Record<string, unknown> {
  const fieldNameToId: Record<string, string> = {};
  for (const [fieldId, field] of Object.entries(template.fields)) {
    fieldNameToId[field.name] = fieldId;
  }

  const fields: Record<string, { id: string; value: string }> = {};
  const fieldValues: string[] = [];

  for (const [fieldName, value] of Object.entries(request.fields)) {
    const fieldId = fieldNameToId[fieldName];
    if (!fieldId) {
      throw new MochiError(
        [
          `Unknown field name: "${fieldName}". Available fields: ${Object.keys(
            fieldNameToId
          ).join(", ")}`,
        ],
        400
      );
    }
    fields[fieldId] = { id: fieldId, value };
    fieldValues.push(value);
  }

  const content = fieldValues.join("\n---\n");

  if (content.trim().length === 0) {
    throw new MochiError(
      [
        `Refusing to create empty card: all provided fields are blank. ` +
          `Template "${template.name}" expects fields: ${Object.values(
            template.fields
          )
            .map((f) => f.name)
            .join(", ")}.`,
      ],
      400
    );
  }

  return {
    content,
    "deck-id": request.deckId,
    "template-id": request.templateId,
    "manual-tags": request.tags,
    fields,
  };
}
