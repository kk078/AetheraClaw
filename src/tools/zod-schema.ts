import { z } from "zod";

// Minimal zod → JSON Schema conversion covering the shapes our tools use
// (objects of strings/numbers/booleans/enums/arrays, optional fields, descriptions).
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return walk(schema);
}

function walk(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as z.ZodType & { _def: { typeName: string; description?: string } })._def;
  const description = def.description ? { description: def.description } : {};

  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...description };
    case "ZodNumber":
      return { type: "number", ...description };
    case "ZodBoolean":
      return { type: "boolean", ...description };
    case "ZodEnum": {
      const values = (def as unknown as { values: string[] }).values;
      return { type: "string", enum: values, ...description };
    }
    case "ZodArray": {
      const inner = (def as unknown as { type: z.ZodType }).type;
      return { type: "array", items: walk(inner), ...description };
    }
    case "ZodOptional":
    case "ZodDefault": {
      const inner = (def as unknown as { innerType: z.ZodType }).innerType;
      return { ...walk(inner), ...description };
    }
    case "ZodNullable": {
      const inner = (def as unknown as { innerType: z.ZodType }).innerType;
      return walk(inner);
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: true, ...description };
    case "ZodUnknown":
    case "ZodAny":
      return { ...description };
    case "ZodObject": {
      const shape = (def as unknown as { shape: () => Record<string, z.ZodType> }).shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = walk(value);
        const vDef = (value as z.ZodType & { _def: { typeName: string } })._def;
        if (vDef.typeName !== "ZodOptional" && vDef.typeName !== "ZodDefault") required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
        ...description,
      };
    }
    default:
      return { ...description };
  }
}
