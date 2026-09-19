import type { JsonSchema } from "../types.js";

/** Infer a JSON schema from one or more example values. */
export function infer(values: unknown[]): JsonSchema {
  const present = values.filter((v) => v !== undefined);
  if (present.length === 0) return { type: "unknown" };

  const first = present[0];

  if (first === null) return { type: "null" };
  if (typeof first === "string") return { type: "string" };
  if (typeof first === "number") return { type: "number" };
  if (typeof first === "boolean") return { type: "boolean" };

  if (Array.isArray(first)) {
    const items = present.flatMap((v) => (Array.isArray(v) ? v : []));
    return { type: "array", items: items.length ? infer(items) : { type: "unknown" } };
  }

  if (typeof first === "object") {
    const objects = present.filter(
      (v): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v),
    );

    const keys = new Set(objects.flatMap((o) => Object.keys(o)));
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const key of keys) {
      properties[key] = infer(objects.map((o) => o[key]));
      // Required only if every example had it — otherwise the generated type
      // would lie about responses the caller will actually receive.
      if (objects.every((o) => key in o)) required.push(key);
    }

    return { type: "object", properties, required };
  }

  return { type: "unknown" };
}

/** Render a schema as a TypeScript type literal. */
export function toTs(schema: JsonSchema, indent = 0): string {
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);

  switch (schema.type) {
    case "string":
    case "number":
    case "boolean":
      return schema.type;
    case "null":
      return "null";
    case "unknown":
      return "unknown";
    case "array":
      return `${toTs(schema.items, indent)}[]`;
    case "object": {
      const entries = Object.entries(schema.properties);
      if (entries.length === 0) return "Record<string, unknown>";
      const body = entries
        .map(([k, v]) => {
          const optional = schema.required.includes(k) ? "" : "?";
          return `${pad}${safeKey(k)}${optional}: ${toTs(v, indent + 1)};`;
        })
        .join("\n");
      return `{\n${body}\n${close}}`;
    }
  }
}

function safeKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Compare a live response against the captured schema. Returns drift notes. */
export function diff(schema: JsonSchema, value: unknown, path = "$"): string[] {
  switch (schema.type) {
    case "unknown":
      return [];
    case "null":
      return value === null ? [] : [`${path}: expected null, got ${typeName(value)}`];
    case "string":
    case "number":
    case "boolean":
      return typeof value === schema.type
        ? []
        : [`${path}: expected ${schema.type}, got ${typeName(value)}`];
    case "array":
      if (!Array.isArray(value)) return [`${path}: expected array, got ${typeName(value)}`];
      // Sampling the first element is enough to catch a renamed field without
      // walking a thousand-item response.
      return value.length ? diff(schema.items, value[0], `${path}[0]`) : [];
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path}: expected object, got ${typeName(value)}`];
      }
      const actual = value as Record<string, unknown>;
      const notes: string[] = [];
      for (const key of schema.required) {
        if (!(key in actual)) notes.push(`${path}.${key}: missing`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in actual) notes.push(...diff(sub, actual[key], `${path}.${key}`));
      }
      return notes;
    }
  }
}

function typeName(v: unknown) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
