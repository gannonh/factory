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
- Choose `Cancel` to close the form without creating a sandbox.

## Driving it with Kata Code preview

Preconditions:

- Doctor passes and the simulation is paused.
- The Sandboxes view shows the three seeded sandbox cards.

- **Open the form.** Click `role=button[name='Sandboxes']`, then `role=button[name='New sandbox']`. Textboxes named `Name`, `Host`, and `Image`, a `Kind` select, and a `Capacity` spinbutton appear.
- **Configure.** Fill `Name` with a unique value. Select `docker`, retain `docker.internal`, and set capacity to `2`.
- **Provision.** Click `role=button[name='Provision']`. The form closes and a card with the chosen name and `provisioning` state appears.
- **Prove persistence.** Read `factory.world.v3` and find a sandbox with the entered name, kind, host, image, and capacity.
- **Cancel.** Open the form again, enter a different unique name, and click `role=button[name='Cancel']`. No card or stored sandbox uses the cancelled name.

## Gotchas

- Changing Kind replaces Host with the built-in hint for that kind.
- Name is required. Host falls back to the selected kind's hint, and an invalid capacity falls back to one.
- Provisioning progress needs a running simulation. A paused simulation keeps the new card in its initial provisioning state.
- Reset removes sandboxes that are not part of the seed, but cleanup must still clear only this run's localStorage key.
