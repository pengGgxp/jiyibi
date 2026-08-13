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
    {
      payCycle: undefined,
      incomeForecast: {
        id: "forecast_1",
        targetPaydayDateKey: "2026-08-10",
        minimumIncomeMinor: 0,
        expectedIncomeMinor: 1,
      },
    },
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
