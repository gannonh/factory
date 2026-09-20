# Sandbox creation

The Sandboxes workspace lets a user configure a local, Docker, VPS, or remote sandbox and watch it provision into the pool.

## Sub-features

- `sandbox-open-form` opens and closes the creation form.
- `sandbox-configure` accepts name, kind, host, image, and capacity.
- `sandbox-provision` creates a provisioning sandbox.
- `sandbox-cancel` closes the form without adding a sandbox.
- `sandbox-persist` stores the new sandbox under `factory.world.v3`.

## How to get to it (user POV)

- Choose `Sandboxes` in the left rail, then choose `New sandbox`.
- Submit a named sandbox with `Provision`.
- Press Enter from the Name or Capacity field to submit the same form.
- Choose `Cancel`, or `New sandbox` again, to close the form without creating a sandbox.

## Driving it with agent-browser

Preconditions:

- Doctor passes and the simulation is paused.
- The Sandboxes view shows the three seeded sandbox cards.

- **Open the form.** `agent-browser find role button click --name "Sandboxes"`, then `agent-browser find role button click --name "New sandbox"`. The snapshot lists `textbox "NAME"`, `combobox "KIND"` with value `docker`, `textbox "HOST"` with `docker.internal`, `textbox "IMAGE"` with `ghcr.io/factory/dev:node22`, `spinbutton "CAPACITY"` with `1`, a disabled `button "Provision"`, and `button "Cancel"`.
- **Configure.** `agent-browser find label "Name" fill "vf-box"` enables `Provision`. `agent-browser find label "Capacity" fill "2"`. To change the kind, take the combobox ref from the snapshot and run `agent-browser select @<ref> vps`.
- **Provision.** `agent-browser find role button click --name "Provision"`, then `agent-browser wait --text "vf-box"`. The form closes and a card shows `vf-box`, `docker · docker.internal`, `provisioning`, `0%`, and `allocating docker host`.
- **Prove persistence.** After 1200 ms, read `sandboxes` in `factory.world.v3`. One entry has `name: "vf-box"`, `kind: "docker"`, `host: "docker.internal"`, `image: "ghcr.io/factory/dev:node22"`, `capacity: 2`, `state: "provisioning"`, `progress: 0`, and an `id` starting with `sb-`.
- **Cancel.** Open the form again, fill Name with `vf-cancelled`, and `agent-browser find role button click --name "Cancel"`. After 1200 ms neither the page text nor the stored world contains `vf-cancelled`.

## Gotchas

- The form fields take their names from wrapping labels, which the snapshot shows in uppercase. `find label` ignores case.
- The Kind default is `docker`. Changing Kind replaces Host with the built-in hint for that kind.
- `Provision` is disabled while Name is blank. Host falls back to the selected kind's hint, and a capacity that is not a positive whole number falls back to one.
- Provisioning needs a running simulation and takes about six simulated seconds to reach `running`. A paused simulation keeps the new card at `provisioning` and `0%`.
- Reset removes sandboxes that are not part of the seed.
