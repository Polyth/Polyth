package com.polyth.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RenderRecoveryBudgetTest {
    @Test
    public void recoversTheFirstDeath() {
        RenderRecoveryBudget budget = new RenderRecoveryBudget();
        assertTrue(budget.tryRecover(1_000L));
    }

    @Test
    public void refusesARecoveryLoopInsideTheWindow() {
        RenderRecoveryBudget budget = new RenderRecoveryBudget(2, 60_000L);
        assertTrue(budget.tryRecover(0L));
        assertTrue(budget.tryRecover(5_000L));
        assertFalse(budget.tryRecover(10_000L));
        assertFalse(budget.tryRecover(59_999L));
    }

    @Test
    public void budgetFreesUpAfterTheWindow() {
        RenderRecoveryBudget budget = new RenderRecoveryBudget(2, 60_000L);
        assertTrue(budget.tryRecover(0L));
        assertTrue(budget.tryRecover(30_000L));
        assertFalse(budget.tryRecover(40_000L));
        // The first death has aged out; the second still counts.
        assertTrue(budget.tryRecover(60_000L));
        assertFalse(budget.tryRecover(61_000L));
        // Both remaining entries age out.
        assertTrue(budget.tryRecover(200_000L));
    }

    @Test
    public void refusedDeathsDoNotExtendTheWindow() {
        RenderRecoveryBudget budget = new RenderRecoveryBudget(1, 10_000L);
        assertTrue(budget.tryRecover(0L));
        assertFalse(budget.tryRecover(9_000L));
        assertTrue(budget.tryRecover(10_000L));
    }

    @Test
    public void aClockGoingBackwardsKeepsEntries() {
        RenderRecoveryBudget budget = new RenderRecoveryBudget(1, 10_000L);
        assertTrue(budget.tryRecover(100_000L));
        assertFalse(budget.tryRecover(50L));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsAnEmptyBudget() {
        new RenderRecoveryBudget(0, 1_000L);
    }
}
