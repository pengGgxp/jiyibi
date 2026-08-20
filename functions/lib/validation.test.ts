import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { validateSyncRequest } from "./validation";

function validRequest(): unknown {
  return {
    schemaVersion: 1,
    cursor: "0",
    mutations: [
      {
        id: "mutation_1",
        entityType: "entry",
        entityId: "entry_1",
        baseVersion: 0,
        payload: {
          id: "entry_1",
          amountMinor: -1250,
          note: "lunch",
          occurredAt: "2026-07-30T04:00:00.000Z",
          localDateKey: "2026-07-30",
          localMonthKey: "2026-07",
          timezoneOffsetMinutes: -480,
          createdAt: "2026-07-30T04:01:00.000Z",
          updatedAt: "2026-07-30T04:01:00.000Z",
        },
      },
    ],
  };
}

describe("validateSyncRequest", () => {
  it("accepts a strict version-one entry mutation", () => {
    expect(validateSyncRequest(validRequest())).toMatchObject({
      schemaVersion: 1,
      cursor: "0",
      mutations: [{ entityType: "entry", entityId: "entry_1" }],
    });
  });

  it("accepts version-two settings with or without a monthly ending balance goal", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 2;
    const settingsPayload = {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 500,
      schemaVersion: 1,
      updatedAt: "2026-07-30T04:01:00.000Z",
    } as const;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: settingsPayload,
    }];

    expect(validateSyncRequest(request).mutations[0].payload).toEqual(settingsPayload);

    for (const goal of [-12_345, 0, 12_345]) {
      const withGoal = structuredClone(request) as {
        mutations: Array<{ payload: Record<string, unknown> }>;
      };
      withGoal.mutations[0].payload.monthEndBalanceGoalMinor = goal;
      expect(validateSyncRequest(withGoal).mutations[0].payload).toMatchObject({
        monthEndBalanceGoalMinor: goal,
      });
    }

    const withoutGoal = structuredClone(request) as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    withoutGoal.mutations[0].payload.monthEndBalanceGoalMinor = null;
    expect(validateSyncRequest(withoutGoal).mutations[0].payload).toMatchObject({
      monthEndBalanceGoalMinor: null,
    });
  });

  it.each([1.5, 9_000_000_000_000_001])(
    "rejects an invalid monthly ending balance goal: %s",
    (goal) => {
      const request = validRequest() as {
        schemaVersion: number;
        mutations: Array<Record<string, unknown>>;
      };
      request.schemaVersion = 2;
      request.mutations = [{
        id: "mutation_settings_1",
        entityType: "settings",
        entityId: "primary",
        baseVersion: 0,
        payload: {
          id: "primary",
          currency: "CNY",
          initialBalanceMinor: 500,
          monthEndBalanceGoalMinor: goal,
          schemaVersion: 1,
          updatedAt: "2026-07-30T04:01:00.000Z",
        },
      }];

      expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");
    },
  );

  it("accepts a complete version-three pay cycle or an explicit null", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 3;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: {
          paydayDay: 10,
          monthlySalaryMinor: 800_000,
          cycleEndBalanceGoalMinor: 100_000,
        },
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      payCycle: {
        paydayDay: 10,
        monthlySalaryMinor: 800_000,
        cycleEndBalanceGoalMinor: 100_000,
      },
    });
    const cleared = structuredClone(request) as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    cleared.mutations[0].payload.payCycle = null;
    expect(validateSyncRequest(cleared).mutations[0].payload).toMatchObject({
      payCycle: null,
    });
  });

  it.each([
    { paydayDay: 0, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 32, monthlySalaryMinor: 1, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 0, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 1.5, cycleEndBalanceGoalMinor: 0 },
    { paydayDay: 10, monthlySalaryMinor: 1 },
  ])("rejects an invalid version-three pay cycle: %o", (payCycle) => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 3;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");
  });

  it("keeps version two strict and rejects the version-three pay cycle", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 2;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: {
          paydayDay: 10,
          monthlySalaryMinor: 800_000,
          cycleEndBalanceGoalMinor: 100_000,
        },
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(() => validateSyncRequest(request)).toThrowError("invalid fields");
  });

  it("accepts version-four pay-cycle and income-forecast fields or explicit nulls", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 4;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: {
          paydayDay: 10,
          cycleEndBalanceGoalMinor: 100_000,
        },
        incomeForecast: {
          id: "forecast_2026_08_10",
          targetPaydayDateKey: "2026-08-10",
          minimumIncomeMinor: 600_000,
          expectedIncomeMinor: 800_000,
        },
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 100_000 },
      incomeForecast: {
        minimumIncomeMinor: 600_000,
        expectedIncomeMinor: 800_000,
      },
    });

    const cleared = structuredClone(request) as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    cleared.mutations[0].payload.payCycle = null;
    cleared.mutations[0].payload.incomeForecast = null;
    expect(validateSyncRequest(cleared).mutations[0].payload).toMatchObject({
      payCycle: null,
      incomeForecast: null,
    });
  });

  it.each([
    {
      id: "forecast_1",
      targetPaydayDateKey: "2026-02-30",
      minimumIncomeMinor: 1,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast_1",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 3,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast_1",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: -1,
      expectedIncomeMinor: 2,
    },
    {
      id: "forecast_1",
      targetPaydayDateKey: "2026-08-10",
      minimumIncomeMinor: 1,
    },
  ])("rejects an invalid version-four income forecast: %o", (incomeForecast) => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 4;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 0 },
        incomeForecast,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");
  });

  it("keeps version three and version four pay-cycle shapes distinct", () => {
    const base = {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 500,
      schemaVersion: 1,
      updatedAt: "2026-07-30T04:01:00.000Z",
    };
    const request = validRequest() as {
      schemaVersion: number;
      mutations: Array<Record<string, unknown> & {
        payload: Record<string, unknown>;
      }>;
    };
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: base,
    }];

    request.schemaVersion = 3;
    request.mutations[0].payload = {
      ...base,
      payCycle: { paydayDay: 10, cycleEndBalanceGoalMinor: 0 },
    };
    expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");

    request.schemaVersion = 4;
    request.mutations[0].payload = {
      ...base,
      payCycle: {
        paydayDay: 10,
        monthlySalaryMinor: 100,
        cycleEndBalanceGoalMinor: 0,
      },
    };
    expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");
  });

  it.each([
    { payCycle: null, incomeForecast: undefined },
    {
      payCycle: null,
      incomeForecast: {
        id: "forecast_1",
        targetPaydayDateKey: "2026-08-10",
        minimumIncomeMinor: 0,
        expectedIncomeMinor: 1,
      },
    },
  ])("rejects an incomplete version-four income planning pair: %o", ({
    payCycle,
    incomeForecast,
  }) => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 4;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle,
        incomeForecast,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];
    expect(() => validateSyncRequest(request)).toThrowError("Settings payload is invalid");
  });

  it("keeps version one strict and rejects the version-two settings field", () => {
    const request = validRequest() as {
      mutations: Array<Record<string, unknown>>;
    };
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 0,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        monthEndBalanceGoalMinor: 12_345,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(() => validateSyncRequest(request)).toThrowError("invalid fields");
  });

  it("rejects unknown fields", () => {
    const request = validRequest() as Record<string, unknown>;
    request.unexpected = true;
    expect(() => validateSyncRequest(request)).toThrowError(ApiError);
  });

  it("rejects a local date that disagrees with the stored timezone", () => {
    const request = validRequest() as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.mutations[0].payload.localDateKey = "2026-07-29";
    expect(() => validateSyncRequest(request)).toThrowError("Entry payload is invalid");
  });

  it("rejects non-canonical or out-of-range cursors", () => {
    const request = validRequest() as Record<string, unknown>;
    request.cursor = "01";
    expect(() => validateSyncRequest(request)).toThrowError("decimal string");
    request.cursor = "9223372036854775808";
    expect(() => validateSyncRequest(request)).toThrowError("decimal string");
  });

  it("rejects duplicate mutation IDs before applying writes", () => {
    const request = validRequest() as { mutations: unknown[] };
    request.mutations.push(structuredClone(request.mutations[0]));
    expect(() => validateSyncRequest(request)).toThrowError("must be unique");
  });

  it("rejects multiple version steps for the same entity in one request", () => {
    const request = validRequest() as {
      mutations: Array<{
        id: string;
        baseVersion: number;
        payload: Record<string, unknown>;
      }>;
    };
    const second = structuredClone(request.mutations[0]);
    second.id = "mutation_2";
    second.baseVersion = 1;
    second.payload.note = "second edit";
    request.mutations.push(second);

    expect(() => validateSyncRequest(request)).toThrowError(
      "At most one mutation per entity",
    );
  });

  it("requires valid analysis fields on version-five entries", () => {
    const request = validRequest() as {
      schemaVersion: number;
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.schemaVersion = 5;
    request.mutations[0].payload.treatment = "ordinary_expense";
    request.mutations[0].payload.confirmationStatus = "pending";
    request.mutations[0].payload.detectionRuleVersion = 1;
    request.mutations[0].payload.promptedRevision = "2026-07-30T04:02:00.000Z";

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      treatment: "ordinary_expense",
      confirmationStatus: "pending",
      detectionRuleVersion: 1,
    });

    const missing = structuredClone(request);
    delete missing.mutations[0].payload.treatment;
    expect(() => validateSyncRequest(missing)).toThrowError("invalid fields");

    request.mutations[0].payload.treatment = "ordinary_income";
    expect(() => validateSyncRequest(request)).toThrowError("Entry payload is invalid");
  });

  it("accepts periodic expenses only in version nine", () => {
    const request = validRequest() as {
      schemaVersion: number;
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.schemaVersion = 9;
    request.mutations[0].payload.treatment = "periodic_expense";
    request.mutations[0].payload.confirmationStatus = "confirmed";

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      treatment: "periodic_expense",
    });

    const legacy = structuredClone(request);
    legacy.schemaVersion = 8;
    expect(() => validateSyncRequest(legacy)).toThrowError("Entry payload is invalid");
  });

  it("accepts strict version-five recovery allocation mutations only", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 5;
    request.mutations = [{
      id: "mutation_recovery_1",
      entityType: "recoveryAllocation",
      entityId: "recovery_1",
      baseVersion: 0,
      payload: {
        id: "recovery_1",
        refundEntryId: "entry_refund",
        expenseEntryId: "entry_expense",
        amountMinor: 500,
        createdAt: "2026-07-30T04:01:00.000Z",
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(validateSyncRequest(request).mutations[0]).toMatchObject({
      entityType: "recoveryAllocation",
      payload: { amountMinor: 500 },
    });

    const old = structuredClone(request);
    old.schemaVersion = 4;
    expect(() => validateSyncRequest(old)).toThrowError("Mutation is invalid");

    const overdrawn = structuredClone(request) as {
      mutations: Array<{ payload: { amountMinor: number } }>;
    };
    overdrawn.mutations[0].payload.amountMinor = 0;
    expect(() => validateSyncRequest(overdrawn)).toThrowError(
      "Recovery allocation payload is invalid",
    );
  });

  it("accepts version-six retained-money settings and partial patches", () => {
    const base = {
      id: "primary",
      currency: "CNY",
      initialBalanceMinor: 500,
      schemaVersion: 1,
      updatedAt: "2026-07-30T04:01:00.000Z",
    } as const;
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 6;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 1,
      payload: {
        ...base,
        payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 100_000 },
        savingsTargetOverride: {
          targetPaydayDateKey: "2026-08-12",
          targetMinor: 80_000,
        },
      },
    }];

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      payCycle: { paydayDay: 10, defaultSavingsTargetMinor: 100_000 },
      savingsTargetOverride: { targetPaydayDateKey: "2026-08-12", targetMinor: 80_000 },
    });

    request.mutations[0] = {
      id: "mutation_settings_2",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 2,
      payload: {
        ...base,
        incomeForecast: {
          id: "forecast_2026_08_12",
          targetPaydayDateKey: "2026-08-12",
          minimumIncomeMinor: 600_000,
          expectedIncomeMinor: 800_000,
        },
      },
    };
    expect(validateSyncRequest(request).mutations[0].payload).not.toHaveProperty("payCycle");
  });

  it("requires explicit dependent clears when version six clears a pay cycle", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 6;
    request.mutations = [{
      id: "mutation_settings_1",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 1,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: null,
        incomeForecast: null,
        savingsTargetOverride: null,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];
    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      payCycle: null,
      incomeForecast: null,
      savingsTargetOverride: null,
    });

    const missingOverrideClear = structuredClone(request) as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    delete missingOverrideClear.mutations[0].payload.savingsTargetOverride;
    expect(() => validateSyncRequest(missingOverrideClear)).toThrowError("Settings payload is invalid");
  });

  it("accepts strict version-six savings events and rejects legacy or invalid shapes", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 6;
    request.mutations = [{
      id: "mutation_savings_1",
      entityType: "savingsEvent",
      entityId: "savings_1",
      baseVersion: 0,
      payload: {
        id: "savings_1",
        kind: "reserve",
        amountMinor: 50_000,
        note: "本周期留存",
        occurredAt: "2026-07-30T04:01:00.000Z",
        localDateKey: "2026-07-30",
        localMonthKey: "2026-07",
        timezoneOffsetMinutes: -480,
        createdAt: "2026-07-30T04:01:00.000Z",
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];
    expect(validateSyncRequest(request).mutations[0]).toMatchObject({
      entityType: "savingsEvent",
      payload: { kind: "reserve", amountMinor: 50_000 },
    });

    const legacy = structuredClone(request);
    legacy.schemaVersion = 5;
    expect(() => validateSyncRequest(legacy)).toThrowError("Mutation is invalid");

    const zeroReserve = structuredClone(request) as {
      mutations: Array<{ payload: { amountMinor: number } }>;
    };
    zeroReserve.mutations[0].payload.amountMinor = 0;
    expect(() => validateSyncRequest(zeroReserve)).toThrowError("Savings event payload is invalid");
  });

  it("accepts version-seven single-income and cumulative-goal settings", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 7;
    request.mutations = [{
      id: "mutation_settings_v7",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 3,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: { paydayDay: 31 },
        incomeForecast: {
          id: "forecast_2026_08_31",
          targetPaydayDateKey: "2026-08-31",
          expectedIncomeMinor: 800_000,
        },
        savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 1_000_000 },
        lastExpectedIncomeMinor: 800_000,
        savingsGoalNeedsSetup: null,
        schemaVersion: 1,
        updatedAt: "2026-07-30T04:01:00.000Z",
      },
    }];

    expect(validateSyncRequest(request).mutations[0].payload).toMatchObject({
      payCycle: { paydayDay: 31 },
      incomeForecast: { expectedIncomeMinor: 800_000 },
      savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 1_000_000 },
      lastExpectedIncomeMinor: 800_000,
      savingsGoalNeedsSetup: null,
    });

    const dualScenario = structuredClone(request) as {
      mutations: Array<{ payload: { incomeForecast: Record<string, unknown> } }>;
    };
    dualScenario.mutations[0].payload.incomeForecast.minimumIncomeMinor = 600_000;
    expect(() => validateSyncRequest(dualScenario)).toThrowError("Settings payload is invalid");

    const cycleTarget = structuredClone(request) as {
      mutations: Array<{ payload: { payCycle: Record<string, unknown> } }>;
    };
    cycleTarget.mutations[0].payload.payCycle.defaultSavingsTargetMinor = 100_000;
    expect(() => validateSyncRequest(cycleTarget)).toThrowError("Settings payload is invalid");

    const contradictoryGoal = structuredClone(request) as {
      mutations: Array<{ payload: { savingsGoalNeedsSetup: true | null } }>;
    };
    contradictoryGoal.mutations[0].payload.savingsGoalNeedsSetup = true;
    expect(() => validateSyncRequest(contradictoryGoal)).toThrowError(
      "Settings payload is invalid",
    );
  });

  it("validates an atomic version-seven income confirmation", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 7;
    request.mutations = [{
      id: "mutation_confirm_income",
      entityType: "settings",
      entityId: "primary",
      baseVersion: 3,
      payload: {
        id: "primary",
        currency: "CNY",
        initialBalanceMinor: 500,
        payCycle: { paydayDay: 31 },
        incomeForecast: null,
        lastExpectedIncomeMinor: 800_000,
        incomeConfirmation: {
          confirmationId: "confirmation_1",
          forecastId: "forecast_2026_08_31",
          targetPaydayDateKey: "2026-08-31",
          expectedIncomeMinor: 800_000,
          actualIncomeMinor: 750_000,
          confirmedAt: "2026-08-31T01:00:00.000Z",
          entryMutationId: "mutation_actual_income_1",
          entry: {
            id: "forecast_2026_08_31",
            amountMinor: 750_000,
            note: "本次实际收入",
            occurredAt: "2026-08-31T01:00:00.000Z",
            localDateKey: "2026-08-31",
            localMonthKey: "2026-08",
            timezoneOffsetMinutes: -480,
            treatment: "ordinary_income",
            confirmationStatus: "confirmed",
            createdAt: "2026-08-31T01:00:00.000Z",
            updatedAt: "2026-08-31T01:00:00.000Z",
          },
        },
        schemaVersion: 1,
        updatedAt: "2026-08-31T01:00:00.000Z",
      },
    }];

    expect(validateSyncRequest(request).mutations[0]).toMatchObject({
      payload: {
        incomeForecast: null,
        incomeConfirmation: { actualIncomeMinor: 750_000 },
      },
    });

    const mismatched = structuredClone(request) as {
      mutations: Array<{ payload: { incomeConfirmation: { actualIncomeMinor: number } } }>;
    };
    mismatched.mutations[0].payload.incomeConfirmation.actualIncomeMinor = 1;
    expect(() => validateSyncRequest(mismatched)).toThrowError("Settings payload is invalid");

    const zero = structuredClone(request) as {
      mutations: Array<{ payload: { incomeConfirmation: Record<string, unknown> } }>;
    };
    zero.mutations[0].payload.incomeConfirmation.actualIncomeMinor = 0;
    delete zero.mutations[0].payload.incomeConfirmation.entry;
    delete zero.mutations[0].payload.incomeConfirmation.entryMutationId;
    expect(() => validateSyncRequest(zero)).not.toThrow();

    const delayed = structuredClone(request) as {
      mutations: Array<{
        payload: {
          incomeConfirmation: {
            targetPaydayDateKey: string;
            confirmedAt: string;
            entry: {
              occurredAt: string;
              localDateKey: string;
              localMonthKey: string;
              createdAt: string;
              updatedAt: string;
            };
          };
        };
      }>;
    };
    const delayedConfirmation = delayed.mutations[0].payload.incomeConfirmation;
    delayedConfirmation.targetPaydayDateKey = "2026-08-15";
    delayedConfirmation.confirmedAt = "2026-08-18T02:00:00.000Z";
    delayedConfirmation.entry.occurredAt = "2026-08-18T01:00:00.000Z";
    delayedConfirmation.entry.localDateKey = "2026-08-18";
    delayedConfirmation.entry.localMonthKey = "2026-08";
    delayedConfirmation.entry.createdAt = "2026-08-18T01:00:00.000Z";
    delayedConfirmation.entry.updatedAt = "2026-08-18T01:00:00.000Z";
    expect(() => validateSyncRequest(delayed)).not.toThrow();

    const beforeForecast = structuredClone(delayed);
    beforeForecast.mutations[0].payload.incomeConfirmation.targetPaydayDateKey = "2026-08-19";
    expect(() => validateSyncRequest(beforeForecast)).toThrowError(
      "Settings payload is invalid",
    );

    const beforeOccurrence = structuredClone(delayed);
    beforeOccurrence.mutations[0].payload.incomeConfirmation.confirmedAt =
      "2026-08-18T00:59:59.999Z";
    expect(() => validateSyncRequest(beforeOccurrence)).toThrowError(
      "Settings payload is invalid",
    );
  });

  it("accepts version-eight settings locks and balance adjustments", () => {
    const request = validRequest() as { schemaVersion: number; mutations: unknown[] };
    request.schemaVersion = 8;
    request.mutations = [
      {
        id: "mutation_lock_1",
        entityType: "settings",
        entityId: "primary",
        baseVersion: 1,
        payload: {
          id: "primary",
          currency: "CNY",
          initialBalanceMinor: 500,
          initialBalanceLockedAt: "2026-08-31T01:00:00.000Z",
          schemaVersion: 1,
          updatedAt: "2026-08-31T01:00:00.000Z",
        },
      },
      {
        id: "mutation_adjustment_1",
        entityType: "balanceAdjustment",
        entityId: "adjustment_1",
        baseVersion: 0,
        payload: {
          id: "adjustment_1",
          kind: "reconciliation",
          amountMinor: -250,
          balanceBeforeMinor: 1_000,
          observedBalanceMinor: 750,
          note: "cash check",
          occurredAt: "2026-08-31T01:00:00.000Z",
          localDateKey: "2026-08-31",
          localMonthKey: "2026-08",
          timezoneOffsetMinutes: 0,
          createdAt: "2026-08-31T01:00:00.000Z",
          updatedAt: "2026-08-31T01:00:00.000Z",
        },
      },
    ];

    expect(validateSyncRequest(request).mutations).toHaveLength(2);
    const openingCorrection = structuredClone(request) as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    openingCorrection.mutations = [openingCorrection.mutations[1]];
    openingCorrection.mutations[0].payload = {
      ...openingCorrection.mutations[0].payload,
      kind: "opening_correction",
      amountMinor: 200,
      previousOpeningMinor: 500,
      nextOpeningMinor: 700,
    };
    delete openingCorrection.mutations[0].payload.balanceBeforeMinor;
    delete openingCorrection.mutations[0].payload.observedBalanceMinor;
    expect(() => validateSyncRequest(openingCorrection)).not.toThrow();
  });

  it("rejects invalid or pre-v8 balance adjustments", () => {
    const request = validRequest() as {
      schemaVersion: number;
      mutations: Array<{
        entityType: string;
        entityId: string;
        baseVersion?: number;
        payload: Record<string, unknown>;
      }>;
    };
    request.schemaVersion = 8;
    request.mutations[0] = {
      ...request.mutations[0],
      entityType: "balanceAdjustment",
      entityId: "adjustment_1",
      payload: {
        id: "adjustment_1",
        kind: "reconciliation",
        amountMinor: 100,
        balanceBeforeMinor: 500,
        observedBalanceMinor: 600,
        note: "",
        occurredAt: "2026-07-30T04:00:00.000Z",
        localDateKey: "2026-07-30",
        localMonthKey: "2026-07",
        timezoneOffsetMinutes: 0,
        createdAt: "2026-07-30T04:00:00.000Z",
        updatedAt: "2026-07-30T04:00:00.000Z",
      },
    };
    const wrongDelta = structuredClone(request);
    wrongDelta.mutations[0].payload.amountMinor = 99;
    expect(() => validateSyncRequest(wrongDelta)).toThrowError(ApiError);
    const zeroDelta = structuredClone(request);
    zeroDelta.mutations[0].payload.amountMinor = 0;
    zeroDelta.mutations[0].payload.observedBalanceMinor = 500;
    expect(() => validateSyncRequest(zeroDelta)).toThrowError(ApiError);
    const lateVoid = structuredClone(request);
    lateVoid.mutations[0].payload.updatedAt = "2026-07-30T04:00:09.000Z";
    lateVoid.mutations[0].payload.deletedAt = "2026-07-30T04:00:09.000Z";
    expect(() => validateSyncRequest(lateVoid)).toThrowError(ApiError);
    const resurrection = structuredClone(request);
    resurrection.mutations[0].baseVersion = 2;
    expect(() => validateSyncRequest(resurrection)).toThrowError(ApiError);
    const legacy = structuredClone(request);
    legacy.schemaVersion = 7;
    expect(() => validateSyncRequest(legacy)).toThrowError(ApiError);
  });

  it("accepts a create-then-delete tombstone without requiring its local attachment", () => {
    const request = validRequest() as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.mutations[0].payload.note = "";
    request.mutations[0].payload.attachmentId = "attachment_local_only";
    request.mutations[0].payload.deletedAt = "2026-07-30T04:01:00.000Z";
    const parsed = validateSyncRequest(request);
    expect(parsed.mutations[0].payload).not.toHaveProperty("attachmentId");
  });
});
