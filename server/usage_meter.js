function createUsageMeter(db, userId, flushIntervalMs = 5000) {
    let pendingBytes = 0;
    let stopped = false;

    const flush = () => {
        if (!userId || pendingBytes <= 0) return 0;
        const bytes = pendingBytes;
        pendingBytes = 0;
        try {
            db.updateUsage(userId, db.getLocalDateString(), bytes);
            return bytes;
        } catch (error) {
            pendingBytes += bytes;
            throw error;
        }
    };

    const interval = userId
        ? setInterval(() => {
            try {
                flush();
            } catch (error) {
                console.error(`[USAGE] Failed to flush ${pendingBytes} pending bytes: ${error.message}`);
            }
        }, flushIntervalMs)
        : null;
    interval?.unref?.();

    return {
        add(bytes) {
            if (stopped || !userId) return;
            const value = Number(bytes);
            if (Number.isFinite(value) && value > 0) pendingBytes += value;
        },
        flush,
        stop() {
            if (stopped) return;
            stopped = true;
            if (interval) clearInterval(interval);
            try {
                flush();
            } catch (error) {
                console.error(`[USAGE] Final flush failed: ${error.message}`);
            }
        },
        pending() {
            return pendingBytes;
        }
    };
}

module.exports = { createUsageMeter };
