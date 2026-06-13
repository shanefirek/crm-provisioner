// Overlay resolver: template + delta → effective spec.
// Default-deny: any delta touching an undeclared extension point is REJECTED.
// "Closed grammar" applied to spec authoring — the fail-closed principle (configuration-philosophy
// cross-cutting rule 4) generalized from cost-policy to provisioning-policy.

import type { DeltaSpec, ExtensionPoint, ProvisionSpec, Template } from "./spec.ts";

export type OverlayError = {
  code: "UNDECLARED_EXTENSION_POINT" | "REPLACE_FORBIDDEN" | "TEMPLATE_NOT_FOUND";
  path: string;
  message: string;
};

export type OverlayResult =
  | { ok: true; spec: ProvisionSpec; spec_hash: string }
  | { ok: false; errors: OverlayError[] };

// Paths the delta is allowed to touch, looked up against the template's declared extension points.
function pointFor(points: ExtensionPoint[], path: string): ExtensionPoint | undefined {
  // Exact match for now; v1 spec only has flat top-level keys + 'pipelines[].stages'.
  return points.find((p) => p.path === path);
}

export function applyOverlay(template: Template, delta: DeltaSpec): OverlayResult {
  const errors: OverlayError[] = [];
  const base = template.base;
  const out: ProvisionSpec = JSON.parse(JSON.stringify(base));
  out.extends = `${template.id}@${template.version}`;

  // fields: append (no duplicate api_names)
  if (delta.fields.length) {
    const pt = pointFor(template.extension_points, "fields");
    if (!pt) errors.push(undeclared("fields"));
    else {
      const seen = new Set(out.fields.map((f) => `${f.module}.${f.api_name}`));
      for (const f of delta.fields) {
        const key = `${f.module}.${f.api_name}`;
        if (seen.has(key)) continue; // delta may restate an existing field; idempotent
        out.fields.push(f);
        seen.add(key);
      }
    }
  }

  // stages: append
  if (delta.stages.length) {
    const pt = pointFor(template.extension_points, "stages");
    if (!pt) errors.push(undeclared("stages"));
    else {
      const seen = new Set(out.stages.map((s) => s.api_name));
      for (const s of delta.stages) {
        if (!seen.has(s.api_name)) {
          out.stages.push(s);
          seen.add(s.api_name);
        }
      }
    }
  }

  // pipelines: stages may be appended onto a base pipeline; whole pipelines also appendable
  if (delta.pipelines.length) {
    const ptStages = pointFor(template.extension_points, "pipelines[].stages");
    const ptPipes = pointFor(template.extension_points, "pipelines");
    for (const p of delta.pipelines) {
      const existing = out.pipelines.find((x) => x.api_name === p.api_name);
      if (existing) {
        if (!ptStages) errors.push(undeclared("pipelines[].stages"));
        else {
          const seen = new Set(existing.stages);
          for (const s of p.stages) if (!seen.has(s)) { existing.stages.push(s); seen.add(s); }
        }
      } else {
        if (!ptPipes) errors.push(undeclared("pipelines"));
        else out.pipelines.push(p);
      }
    }
  }

  // workflows: append
  if (delta.workflows.length) {
    const pt = pointFor(template.extension_points, "workflows");
    if (!pt) errors.push(undeclared("workflows"));
    else {
      const seen = new Set(out.workflows.map((w) => w.api_name));
      for (const w of delta.workflows) {
        if (!seen.has(w.api_name)) {
          out.workflows.push(w);
          seen.add(w.api_name);
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: out, spec_hash: stableHash(out) };
}

function undeclared(path: string): OverlayError {
  return {
    code: "UNDECLARED_EXTENSION_POINT",
    path,
    message: `delta touches "${path}" but the template does not declare an extension point there. Either author the delta against the template's declared points or use the no-template path.`,
  };
}

// Stable hash for snapshot-on-write (configuration-philosophy rule 3).
// Cheap deterministic JSON canonicalization; not cryptographic.
export function stableHash(obj: unknown): string {
  const json = JSON.stringify(canon(obj));
  let h = 0;
  for (let i = 0; i < json.length; i++) h = ((h << 5) - h + json.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16).padStart(8, "0")}`;
}
function canon(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canon);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canon(o[k]);
  return out;
}
