#!/usr/bin/env node
/**
 * This script submits Postman collection test results to QASE.
 * It reads a Postman JSON report, extracts test case IDs, creates a test run in Qase,
 * and submits the results for each test case.
 */

import fs from 'fs';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// --- Load config from environment variables ---
const QASE_API_TOKEN = process.env.QASE_API_TOKEN;
const QASE_PROJECT_CODE = process.env.QASE_PROJECT_CODE;
const REPORT_FILE = process.env.POSTMAN_JSON_REPORT || "results.json";
const test_run_tag = process.env.QASE_TEST_RUN_TAG || "Local Run";
if (!QASE_API_TOKEN || !QASE_PROJECT_CODE) {
  console.error("❌ Missing QASE_API_TOKEN or QASE_PROJECT_CODE in environment variables.");
  process.exit(1);
}

// --- Load and parse Postman JSON report ---
const postmanResults = JSON.parse(fs.readFileSync(REPORT_FILE, "utf-8"));
const executions = postmanResults.run.executions.map(e => ({
  name: e.requestExecuted.name,
  assertions: e.tests || []
}));

// --- Extract Qase Case IDs ---
const caseIds = [...new Set(executions.map(exec => {
  const match = exec.name.match(/Qase:(\d+)/);
  return match ? parseInt(match[1]) : null;
}).filter(Boolean))];

// --- Create Qase Test Run ---
async function createTestRun(caseIds) {
  const response = await axios.post(
    `https://api.qase.io/v1/run/${QASE_PROJECT_CODE}`,
    {
      title: test_run_tag,
      cases: caseIds,
    },
    {
      headers: {
        Token: QASE_API_TOKEN,
      },
    }
  );
  return response.data.result.id;
}

// --- Submit results to Qase ---
async function submitResults(runId, executions) {
  for (const exec of executions) {
    const match = exec.name.match(/Qase:(\d+)/);
    if (!match) continue;
    const caseId = parseInt(match[1]);

    const qaseSteps = await getCaseSteps(caseId);
    const stepsQase = qaseSteps.map((step, index) => {
      // Try to find a matching assertion by name
      const assertion = exec.assertions.find(a => a.name === unescapeMarkdown(step.expected_result));

      return {
        position: step.position || index + 1,
        action: step.action,
        expected_result: step.expected_result || "Expected result",
        status: assertion ? (assertion.error ? "failed" : "passed") : "failed"
      };
    });
    // Check if the there is a failed test
    const failedChecker = stepsQase.every(a => a.status !== "failed");
    const passed = failedChecker ? "passed" : "failed";
    const comment = exec.assertions.map(a =>
      a.error ? `❌ ${a.name}: ${a.error.message}` : `✅ ${a.name}`
    ).join("\n");

    console.log("test: ", exec.name ," | Status:", passed);
    await axios.post(
      `https://api.qase.io/v1/result/${QASE_PROJECT_CODE}/${runId}`,
      {
        case_id: caseId,
        status: passed,
        comment: comment,
        steps: stepsQase,
      },
      {
        headers: {
          Token: QASE_API_TOKEN,
        },
      }
    );
  }
}
// --- Fetch Qase case steps ---
async function getCaseSteps(caseId) {
  const response = await axios.get(
    `https://api.qase.io/v1/case/${QASE_PROJECT_CODE}/${caseId}`,
    {
      headers: {
        Token: QASE_API_TOKEN,
      },
    }
  );
  return response.data.result.steps || [];
}

function unescapeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  // Unescape commonly escaped Markdown special characters
  return text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}
// --- Main execution ---
(async () => {
  try {
    const runId = await createTestRun(caseIds);
    await submitResults(runId, executions);
    console.log("✅ Qase test run created and results submitted.");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    process.exit(1);
  }
})();
