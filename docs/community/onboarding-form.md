# Community onboarding — application form spec

The intake form for orgs applying to run GitHub Actions jobs on CreateOS Sandbox
runners. Filled in by the applicant (Google Form); reviewed manually; approved
entries become a **Tenant** record in the registry.

Every field below earns its place by answering "who reads this, and what do they
do differently because of the answer?" A field nobody acts on is a field that
lowers completion rate for nothing — if you add one, say who consumes it.

**Consumers:** `BD` = business development / sales · `FIN` = finance ·
`ENG` = engineering / ops · `OPS` = approval workflow itself.

---

## Section 1 — Who you are

| Field | Type | Req | Consumer | Why we ask |
| --- | --- | --- | --- | --- |
| GitHub organization login | short text | ✅ | OPS | The Tenant key. Must match the org that installs the App exactly. |
| Organization / project name | short text | ✅ | BD | Human-readable name for the registry and for outreach. |
| Primary contact — full name | short text | ✅ | BD | Who we reply to. |
| Primary contact — email | email | ✅ | OPS, BD | Approval/rejection notice, quota-exhaustion alerts, everything downstream. |
| Role / title | short text | — | BD | Distinguishes a maintainer from a platform lead from a founder — changes who we route the lead to. |
| Project homepage / website | URL | — | BD | Qualification, and the fastest way to sanity-check the applicant is real. |
| Chat handle (Discord / Telegram / X) | short text | — | BD | Faster support loop than email; also the channel where community advocacy happens. |
| Country / timezone | dropdown | — | BD, ENG | Support-hours overlap, and tells us when their CI peak lands relative to ours. |
| How did you hear about CreateOS? | dropdown + other | — | BD | Attribution. The only way to know which channel produces tenants. |

---

## Section 2 — What you want to run

| Field | Type | Req | Consumer | Why we ask |
| --- | --- | --- | --- | --- |
| Repositories to approve (`owner/name`, one per line) | long text | ✅ | OPS | The Project allowlist. Nothing runs until a repo is on it. |
| Are these repos public or private? | choice | ✅ | ENG | Public repos accept contributions from strangers; changes how we set the runner-group scope and how closely we watch the tenant early on. |
| Primary languages / stack | checkboxes + other | — | ENG | Tells us whether the shared runner image actually serves them (toolchain, `setup-*` actions, Docker). A stack we can't support is a rejection *before* they're disappointed. |
| Open source or commercial? | choice | ✅ | BD, FIN | Free community capacity is aimed at OSS. Commercial applicants are a sales conversation, not a rejection. |
| License (if OSS) | short text | — | BD | Confirms the OSS claim. |
| Monthly active contributors | bucket | — | BD | Reach. A 3-person project and a 200-person project are different leads. |
| GitHub stars | bucket | — | BD | Rough proxy for the marketing value of the logo. |

---

## Section 3 — CI profile (this is what sets the quota)

| Field | Type | Req | Consumer | Why we ask |
| --- | --- | --- | --- | --- |
| Current CI provider | choice + other | ✅ | BD, FIN | The competitive baseline, and the thing they're switching *from*. |
| Approximate jobs per month | bucket | ✅ | ENG, FIN | Primary input to the minute grant. |
| Average job duration | bucket | ✅ | ENG, FIN | Second input to the minute grant; also tells us whether the default 30-minute job TTL will strand them. |
| Peak concurrent jobs needed | bucket | ✅ | ENG | Sets the Tenant concurrency cap. The number that protects *our* capacity. |
| Largest machine size needed | choice (`2vcpu-2gb` / `4vcpu-4gb` / `4vcpu-8gb` / larger) | ✅ | ENG, FIN | Sets the max shape. "Larger" is a conversation, not an automatic no. |
| Do any jobs run longer than 30 minutes? | choice | ✅ | ENG | The default job TTL is 30 min. A yes here means their tenant record needs a raised TTL or their builds die halfway. |
| Do jobs need Docker / Docker-in-Docker? | choice | — | ENG | Supported, but it changes disk and memory expectations. |
| Do jobs need more than 30 GB of disk? | choice | — | ENG | Runner disk is fixed per deployment; a yes needs review. |
| Do jobs need restricted or private egress (private registries, VPN, self-hosted services)? | long text | — | ENG | Runner egress is open by default; private-network access is not something we offer today. Surfaces a hard blocker before approval, not after. |

---

## Section 4 — Commercial signal

The section that turns a free-capacity giveaway into a lead list. Keep it short
and keep every field optional except the last — a required commercial question
on a free-tier form costs completions.

| Field | Type | Req | Consumer | Why we ask |
| --- | --- | --- | --- | --- |
| Current monthly CI spend | bucket (incl. `$0`) | — | FIN, BD | Sizes the opportunity and tells us what we're displacing. |
| Biggest pain with your current CI | long text | — | BD | Product input, and the sentence we quote back in the follow-up. |
| Would you consider a paid plan if this works well? | choice (yes / maybe / no) | — | BD, FIN | Lead scoring. "No" is a fine answer and still a good community tenant. |
| Interested in CreateOS Sandbox beyond CI? | checkboxes (dev environments, agent sandboxes, PR preview environments, batch compute, other) | — | BD | The actual cross-sell surface. CI is the doorway, not the product. |
| Company / org size | bucket | — | BD, FIN | Qualification. |
| Funding stage | choice (bootstrapped / pre-seed / seed / Series A+ / nonprofit / n-a) | — | FIN, BD | Qualification. |

---

## Section 5 — Terms (acknowledgements)

All required checkboxes. These exist so expectations are set in writing *before*
approval, not in an incident thread afterwards.

| Acknowledgement | Why |
| --- | --- |
| Best-effort free capacity, no SLA, no uptime guarantee. | We may be down. They must not put a release train on this without knowing that. |
| Runners are ephemeral single-use microVMs; nothing persists between jobs. | Kills the "where did my cache go" ticket in advance. |
| Do not use these runners for cryptocurrency mining, network abuse, or anything unlawful. | The explicit line that makes revocation uncontroversial. |
| Usage is metered — job counts, minutes, and network egress are recorded per repository. | Consent for the ledger. |
| Access may be modified or revoked at any time, with notice where practical. | The revocation right, stated plainly. |
| Consent to be contacted about CreateOS. | Consent for the lead pipeline. |

---

## Internal registry fields (not on the form)

Set by the approver, stored on the Tenant record. Listed here so the form spec
and the data model stay in sync — if one of these has no form field feeding it
and no sensible default, that is a gap in the form.

| Field | Source | Notes |
| --- | --- | --- |
| `installation_id` | GitHub, after they install the App | The Tenant key used at runtime. Not knowable at form time. |
| `org_login` | form | Must match `installation_id`'s org, verified at approval. |
| `status` | approver | `pending` / `approved` / `suspended` / `revoked`. |
| `approved_at`, `approved_by` | approver | Audit trail. |
| `monthly_minute_grant` | approver, sized from Section 3 | Weighted minutes per calendar month, UTC. |
| `concurrency_cap` | approver, sized from Section 3 | Max simultaneous VMs for this Tenant. |
| `max_shape` | approver, sized from Section 3 | Community default `4vcpu-8gb`. |
| `job_ttl_minutes` | approver, from the >30 min answer | Default 30. |
| `runner_group_id` | created at approval | The per-org runner group, scoped to approved Projects. |
| `allow_all_repos` | approver | NodeOps only. Every community Tenant enumerates its Projects. |
| `projects[]` | form, curated by approver | The approved repo allowlist. |
| `notes` | approver | Free text — why approved, what to watch, who owns the relationship. |

---

## Approval flow

1. Applicant submits the form.
2. Approver reviews. Rejections get a reply explaining why; a rejection is a lead too.
3. Approver creates the Tenant record with grant, caps, and Projects.
4. Applicant installs the public GitHub App on their org and grants the approved repos.
5. Approval creates the per-org runner group scoped to those repos.
6. Applicant switches `runs-on:` to the CreateOS label and their next job boots a microVM.

Steps 3 and 4 are order-independent — a job from an installed-but-unapproved org
is ignored, and the applicant is told so via a check run rather than being left
with a build that hangs until GitHub times it out.
