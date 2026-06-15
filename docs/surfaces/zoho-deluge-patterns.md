# Zoho Workflow + Deluge Patterns

Web-harvested knowledge consolidated 2026-06-13 to upgrade P3's Zoho adapter from "workflows = unsupported" to "supported (subset)". No human input — all sources are public Zoho docs + community canon.

## What S0 got wrong

P3's capability map said `assignment_rules: ❌ manual` and all workflow shapes `⚠️ pattern library`. S0 probed `POST /crm/v8/settings/workflow_rules` and got `INVALID_REQUEST`, concluding the surface was unavailable.

**The actual endpoint is `/crm/v8/settings/automation/workflow_rules`** — under `/automation/`, which S0 missed. Same with email notifications, field updates, automation tasks, and webhooks. All are REST-creatable in v8.

## What IS creatable via v8 REST

| Action / object | Endpoint | Notes |
|---|---|---|
| Workflow rule | `POST /crm/v8/settings/automation/workflow_rules` | Wraps actions. `execute_when.type` ∈ `create | edit | create_or_edit | delete | scheduler | email_received` |
| Email notification action | `POST /crm/v8/settings/automation/email_notifications` | **Requires a pre-existing email template** (template creation is UI-only) |
| Field update action | `POST /crm/v8/settings/automation/field_updates` | Sets a field to a literal value or another field's value |
| Automation task action | `POST /crm/v8/settings/automation/automation_tasks` | Creates a Task record (assigned to owner / specified user) when triggered |
| Webhook action | `POST /crm/v8/settings/automation/webhooks` | Calls an external URL when triggered |

## What is NOT creatable via v8 REST

| Thing | Documented surface | Adapter verdict | Workaround |
|---|---|---|---|
| Standalone Deluge function | `POST /crm/v8/settings/functions` (**corrected 2026-06-14**) | REST-creatable, admin-gated, **adapter wiring pending** | See "Programmatic Deluge function creation" section below. Until the adapter wires it, user can create once in UI (Setup > Developer Hub > Functions) and reference by ID in a workflow rule's `actions` |
| Email template | GET only | `manual` | User creates the template once in UI; idle_deal_alert and any email-based shape can fall back to `automation_tasks` action (no template needed) |
| CRM Variable | None documented | `manual` | Used as state for round-robin patterns; created once in UI |

## Workflow shape → implementation map (current Adapter)

### idle_deal_alert (was UNSUPPORTED → now SUPPORTED, no template needed)

Schedules an automation_task N days after a deal enters a specific stage. Task is assigned to the deal owner.

1. `POST /settings/automation/automation_tasks` → create the "follow up on idle deal" task action. Returns `id`.
2. `POST /settings/automation/workflow_rules`:
   - `execute_when.type = "edit"`, `details.trigger_module.api_name = "Deals"`, `repeat: true`
   - `conditions[0].criteria_details.criteria`: stage equals `<spec.stage>`
   - `conditions[0].scheduled_actions[0]`: `execute_after: { period: "days", unit: spec.idle_days }`, `actions[0]: { id: <task action id>, type: "automation_tasks" }`

Why automation_tasks not email_notifications: email_notifications requires an email template, and templates are UI-only. Tasks are zero-prerequisite.

### field_derivation (was UNSUPPORTED → now SUPPORTED)

Sets `target_field` from `source_field` when the trigger fires.

1. `POST /settings/automation/field_updates` → create the field_update action. Body sets the target field to the source field's value via field reference.
2. `POST /settings/automation/workflow_rules`:
   - `execute_when.type` from `spec.when`: `on_create` → `create`, `on_update` → `edit`, `on_save` → `create_or_edit`
   - `conditions[0].instant_actions.actions[0]`: `{ id: <field_update id>, type: "field_updates" }`

### round_robin_assignment (Deluge IS REST-creatable; adapter wiring pending)

True round-robin in Zoho requires a Deluge function (to compute "next user in pool"). **That function is REST-creatable** — see "Programmatic Deluge function creation" below; the earlier "not REST-creatable" claim was a false verdict from a single malformed S0 probe, corrected 2026-06-14. The adapter still emits `manual` for now only because it does not yet implement the `createDelugeFunction` builder. Until that phase lands, the demo runbook tells the user:

> Create this function once in UI (Setup > Developer Hub > Functions), paste the script below, then the adapter will reference it by ID inside any workflow that needs round-robin.

**Canonical script** (from `github.com/TheWorkflowAcademy/Round-Robin-Owner-Assignment-Deluge` — verified by direct file fetch):

```deluge
// Get a List of Active Users
userslist = invokeurl
[
  url :"https://www.zohoapis.com/crm/v2/users"
  type :GET
  parameters:{"type":"ActiveUsers"}
  connection:"zohocrm_oauth_connection"
];
users = userslist.get("users");

// Make a List of Users with the {ProfileName} Profile
poolusers = List();
for each u in users
{
  if(u.get("profile").get("name").contains("{ProfileName}"))
  {
    poolusers.add(u.get("id"));
  }
}
size = size(poolusers);

// Assign the New Owner ID on a Round Robin Pattern
tasklist = zoho.crm.searchRecords("Tasks","(Subject:starts_with:{TaskSubjectPrefix})");
if(size(tasklist) == 0)
{
  ownerid = poolusers.get(0);
}
else
{
  previousownerid = tasklist.get(0).get("Owner").get("id");
  previousindex = poolusers.indexOf(previousownerid);
  nextindex = (previousindex + 1) % size;
  ownerid = poolusers.get(nextindex);
}

// Create Task & assign
newtask = Map();
newtask.put("Subject","{TaskSubjectPrefix} " + dealname);
newtask.put("Status","Not Started");
newtask.put("$se_module","Deals");
newtask.put("What_Id",dealid);
newtask.put("Due_Date",addBusinessDay(today,5));
newtask.put("Owner",ownerid);
createTask = zoho.crm.createRecord("Tasks",newtask);
```

Substitution points: `{ProfileName}` (e.g. "Service Agent"), `{TaskSubjectPrefix}` (e.g. "Round Robin Follow-up").

State is held in the most-recently-created Task — no CRM Variable needed. (The Zoho-official solution uses CRM Variables; this version uses task search, which is simpler and equally correct.)

## Programmatic Deluge function creation (probed live 2026-06-14)

The create endpoint is **real**. It is `POST /crm/v8/settings/functions` and takes a **form-encoded** body (NOT JSON — a JSON body returns `REQUIRED_PARAM_MISSING: metadata`, which is the exact error S0 hit and wrongly read as "no surface"). The `metadata` form field is a JSON object containing a `functions` array:

```
POST /crm/v8/settings/functions
Authorization: Zoho-oauthtoken <token>
Content-Type: application/x-www-form-urlencoded

metadata={"functions":[{
  "name":         "<api_name>",
  "display_name": "<label>",
  "category":     "Automation",       // enum: Button|Automation|Schedule|Related List|Standalone|Signals|Validation Rule|Dynamic
  "runtime":      "Deluge 1.0",       // enum: Deluge 1.0|Java 8|Java 17|NodeJS 8|NodeJS 22|Python 3.12
  "script":       "void automation.<api_name>(){ ... }",
  "params":       []
}]}
```

Validation walks field-by-field (`name → category → runtime → script`); a well-formed body passes the entire schema. The remaining gate is **authorization, not capability**:

- `"initial function creation is restricted to administrators"` — the connection must be authorized by an **org admin**, and the org's Functions/Developer space must be enabled once (admin creates any function in the UI the first time).
- Reading users (`GET /crm/v8/users`) for the round-robin pool needs `ZohoCRM.users.READ` scope — the narrow `.dev.vars` token lacked it; re-grant with `ZohoCRM.settings.ALL,ZohoCRM.modules.ALL,ZohoCRM.users.READ`.

Status: **REST capability proven; a literal 201 + the `createDelugeFunction` adapter builder are pending an admin-authorized connection.** This is the next phase, not a research unknown.

## Verified body shapes (from official v8 docs)

### Workflow rule POST body (excerpt — the structurally-load-bearing pieces)

```json
{
  "workflow_rules": [{
    "execute_when": {
      "type": "create",
      "details": {
        "trigger_module": { "api_name": "Leads" },
        "repeat": true
      }
    },
    "module": { "api_name": "Leads" },
    "name": "Comprehensive Workflow Example",
    "description": "...",
    "lock": { "status": false },
    "conditions": [{
      "sequence_number": 1,
      "criteria_details": {
        "criteria": {
          "group_operator": "AND",
          "group": [{
            "comparator": "equal",
            "field": { "api_name": "Annual_Revenue" },
            "type": "value",
            "value": "${NOTEMPTY}"
          }]
        }
      },
      "instant_actions": {
        "actions": [
          { "id": "<action_id>", "type": "field_updates" },
          { "id": "<action_id>", "type": "email_notifications" },
          { "id": "<action_id>", "type": "automation_tasks" },
          { "id": "<action_id>", "type": "webhooks" }
        ]
      },
      "scheduled_actions": [{
        "execute_after": { "period": "days", "unit": 2 },
        "actions": [
          { "id": "<action_id>", "type": "automation_tasks" }
        ]
      }]
    }]
  }]
}
```

Notes from the spec:
- Required scope: `ZohoCRM.settings.workflow_rules.CREATE` (or `.ALL`)
- Rule names: max 100 chars, no special characters
- `repeat: true` (mandatory for `edit`/`create_or_edit` triggers) **disallows scheduled_actions** — for idle_deal_alert we use `repeat: false` and accept that the workflow fires once per record-stage-entry
- `sequence_number` starts at 1 and must be sequential

### Email notification POST body (excerpt — for reference; we use tasks instead in MVP)

```json
{
  "email_notifications": [{
    "name": "BigDealNotify",
    "feature_type": "workflow",
    "bulk_email": false,
    "module": { "api_name": "Deals" },
    "template": { "id": "<template_id>" },
    "recipients": {
      "to": [
        { "type": "merge_field", "details": { "api_name": "${!Deals.Created_By}" } },
        { "type": "user", "resource": { "id": "<user_id>" } }
      ]
    }
  }]
}
```

Required scope: `ZohoCRM.settings.automation_actions.CREATE`. **Template ID is mandatory** — and template creation is UI-only.

## Sources

- Zoho v8 API directory: `https://www.zoho.com/crm/developer/docs/api/v8/api-references.html`
- Configure Workflow Rule API: `https://www.zoho.com/crm/developer/docs/api/v8/config-workflow.html`
- Create Email Notification API: `https://www.zoho.com/crm/developer/docs/api/v8/create-email-notification.html`
- Round-robin Deluge canonical script: `github.com/TheWorkflowAcademy/Round-Robin-Owner-Assignment-Deluge`
- Real-estate vertical pipeline / fields canon: `timelines.ai/8-step-checklist-for-setting-up-zoho-crm-for-real-estate-teams`
- Multi-pipeline tutorial (B2B/B2C reference): `www.zoho.com/crm/tutorials/multiple-sales-pipeline/`
