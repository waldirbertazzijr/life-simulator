// Worker thread: evaluate one candidate config across several seeds and return
// a COMPACT result (no big time-series arrays cross the thread boundary).
import { parentPort } from 'worker_threads';
import { evaluate } from './harness.mjs';

// Downsample a series to ~n points so the full trajectory can ride back to the
// dashboard without shipping thousands of samples per candidate.
function downsample(arr, n = 90) {
    if (!arr || arr.length <= n) return arr ? arr.slice() : [];
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
    return out;
}

parentPort.on('message', (msg) => {
    const { id, overrides, opts } = msg;
    try {
        const res = evaluate(overrides, opts);
        const rep = res.rep;
        parentPort.postMessage({
            id,
            score: res.score,
            scores: res.scores,
            completedCount: res.completedCount,
            seeds: res.seeds,
            rep: {
                completed: rep.completed,
                collapseFrame: rep.collapseFrame,
                collapseCause: rep.collapseCause,
                frames: rep.frames,
                finalCounts: rep.finalCounts,
                summary: rep.summary,
                spark: {
                    tree: downsample(rep.series.tree),
                    herbivore: downsample(rep.series.herbivore),
                    carnivore: downsample(rep.series.carnivore),
                },
            },
        });
    } catch (e) {
        parentPort.postMessage({ id, error: String((e && e.stack) || e) });
    }
});
