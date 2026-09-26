import { z } from "zod"

export const MetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  authors: z.array(z.string()),
  estimatedMinutes: z.number(),
})

export const SettingsSchema = z
  .object({
    requireFullscreen: z.boolean().default(true),
    allowedDevices: z
      .array(z.enum(["desktop", "tablet", "phone"]))
      .default(["desktop"]),
    minRefreshHz: z.number().default(50),
    seedStrategy: z.enum(["per-session", "fixed"]).default("per-session"),
    onTabHidden: z.enum(["record", "pause", "abort"]).default("record"),
    maxMinutes: z.number().default(60),
    completionRedirect: z.url().optional(),
  })
  .prefault({})

export const AssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "audio", "video"]),
  storagePath: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
})

export const VariableSchema = z.object({
  name: z.string(),
  type: z.enum(["number", "string", "boolean"]),
})

export const PhaseSchema = z.object({
  type: z.enum(["fixation", "stimulus", "blank", "response", "feedback"]),
  duration: z.union([z.number(), z.literal("untilResponse")]),
  content: z
    .object({
      kind: z.enum(["text", "asset", "column"]),
      value: z.string(),
    })
    .optional(),
})

export const ResponseSchema = z.object({
  allowedKeys: z.array(z.string()),
  timeoutMs: z.number(),
  correctAnswer: z.string().optional(),
  acceptInPhases: z.array(z.number()),
})

export const ConsentNodeSchema = z.object({
  type: z.literal("consent"),
  id: z.string(),
  markdown: z.string(),
  declineNodeId: z.string(),
  next: z.string(),
})

export const InstructionsNodeSchema = z.object({
  type: z.literal("instructions"),
  id: z.string(),
  markdown: z.string(),
  advanceBy: z.enum(["key", "button"]),
  next: z.string(),
})

export const TrialNodeSchema = z.object({
  type: z.literal("trial"),
  id: z.string(),
  phases: z.array(PhaseSchema),
  response: ResponseSchema.optional(),
  next: z.string(),
})

export const BlockNodeSchema = z.object({
  type: z.literal("block"),
  id: z.string(),
  trialTemplate: z.string(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  repetitions: z.number(),
  order: z.enum([
    "fixed",
    "shuffle",
    "shuffle-constrained",
    "blocked-by-column",
  ]),
  orderColumn: z.string().optional(),
  maxConsecutiveRepeats: z.number().optional(),
  practice: z.boolean().default(false),
  breakEveryN: z.number().optional(),
  next: z.string(),
})

export const BranchNodeSchema = z.object({
  type: z.literal("branch"),
  id: z.string(),
  condition: z.string(),
  onTrue: z.string(),
  onFalse: z.string(),
})

export const RandomizerArmSchema = z.object({
  id: z.string(),
  weight: z.number(),
  next: z.string(),
})

export const RandomizerNodeSchema = z.object({
  type: z.literal("randomizer"),
  id: z.string(),
  method: z.enum(["simple-weighted", "balanced", "latin-square"]),
  arms: z.array(RandomizerArmSchema),
})

export const SurveyQuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["likert", "multiple-choice", "free-text"]),
  text: z.string(),
  options: z.array(z.string()).optional(),
})

export const SurveyNodeSchema = z.object({
  type: z.literal("survey"),
  id: z.string(),
  questions: z.array(SurveyQuestionSchema),
  next: z.string(),
})

export const BreakNodeSchema = z.object({
  type: z.literal("break"),
  id: z.string(),
  message: z.string(),
  minimumDurationMs: z.number(),
  next: z.string(),
})

export const EndNodeSchema = z.object({
  type: z.literal("end"),
  id: z.string(),
  message: z.string(),
  redirect: z.url().optional(),
})

export const NodeSchema = z.discriminatedUnion("type", [
  ConsentNodeSchema,
  InstructionsNodeSchema,
  TrialNodeSchema,
  BlockNodeSchema,
  BranchNodeSchema,
  RandomizerNodeSchema,
  SurveyNodeSchema,
  BreakNodeSchema,
  EndNodeSchema,
])

export const ExperimentSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: z.uuid(),
    version: z.number().int().positive(),
    meta: MetaSchema,
    settings: SettingsSchema,
    assets: z.array(AssetSchema),
    variables: z.array(VariableSchema),
    entry: z.string(),
    nodes: z.record(z.string(), NodeSchema),
  })
  .superRefine((data, ctx) => {
    const nodeIds = new Set(Object.keys(data.nodes))

    const checkRef = (nodeId: string, path: (string | number)[]) => {
      if (!nodeIds.has(nodeId)) {
        ctx.addIssue({
          code: "custom",
          message: `References nonexistent node id "${nodeId}"`,
          path,
        })
      }
    }

    if (!nodeIds.has(data.entry)) {
      ctx.addIssue({
        code: "custom",
        message: `entry "${data.entry}" does not reference an existing node`,
        path: ["entry"],
      })
    }

    for (const [nodeId, node] of Object.entries(data.nodes)) {
      const basePath: (string | number)[] = ["nodes", nodeId]

      switch (node.type) {
        case "consent":
          checkRef(node.declineNodeId, [...basePath, "declineNodeId"])
          checkRef(node.next, [...basePath, "next"])
          break
        case "instructions":
          checkRef(node.next, [...basePath, "next"])
          break
        case "trial":
          checkRef(node.next, [...basePath, "next"])
          break
        case "block": {
          checkRef(node.next, [...basePath, "next"])
          const template = data.nodes[node.trialTemplate]
          if (!template) {
            ctx.addIssue({
              code: "custom",
              message: `block.trialTemplate "${node.trialTemplate}" does not reference an existing node`,
              path: [...basePath, "trialTemplate"],
            })
          } else if (template.type !== "trial") {
            ctx.addIssue({
              code: "custom",
              message: `block.trialTemplate "${node.trialTemplate}" must reference a trial node (got "${template.type}")`,
              path: [...basePath, "trialTemplate"],
            })
          }
          break
        }
        case "branch":
          checkRef(node.onTrue, [...basePath, "onTrue"])
          checkRef(node.onFalse, [...basePath, "onFalse"])
          break
        case "randomizer":
          node.arms.forEach((arm, i) => {
            checkRef(arm.next, [...basePath, "arms", i, "next"])
          })
          break
        case "survey":
          checkRef(node.next, [...basePath, "next"])
          break
        case "break":
          checkRef(node.next, [...basePath, "next"])
          break
        case "end":
          break
      }
    }
  })
