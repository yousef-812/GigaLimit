const fs = require('fs');
const path = require('path');

// Save the database file in the same directory where the executable is run
const dbPath = path.join(process.cwd(), 'giga_limit_db.json');

let data = {
    settings: {
        admin_password: 'admin123',
        global_daily_limit_mb: 1024,
        global_weekly_limit_mb: 7168
    },
    users: [], // { id, name, device_id, current_ip, status, daily_limit_mb }
    usage: [] // { user_id, date, bytes_used }
};

if (fs.existsSync(dbPath)) {
    try {
        const fileData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        data = { ...data, ...fileData };
        if (data.settings && data.settings.global_total_bytes_used === undefined) {
            data.settings.global_total_bytes_used = 0;
        }
    } catch (e) {
        console.error('Error reading db file, starting fresh.');
    }
}

const getLocalDateString = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const save = () => {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

// Ensure initial save
save();

module.exports = {
    getSetting: (key) => data.settings[key],
    
    registerUser: (name, device_id, ip, default_limit) => {
        let user = data.users.find(u => u.device_id === device_id);
        if (!user) {
            let existingIpUser = data.users.find(u => u.current_ip === ip);
            if (existingIpUser) {
                existingIpUser.device_id = device_id;
                if (name) existingIpUser.name = name;
                user = existingIpUser;
            } else {
                const maxId = data.users.reduce((max, u) => Math.max(max, u.id), 0);
                user = {
                    id: maxId + 1,
                    name,
                    device_id,
                    current_ip: ip,
                    daily_limit_mb: default_limit,
                    weekly_limit_mb: default_limit * 7,
                    status: 'active',
                    registered_at: getLocalDateString()
                };
                data.users.push(user);
            }
        } else {
            user.current_ip = ip;
            if (name) user.name = name;
        }
        save();
        return user;
    },

    updateUserIp: (device_id, current_ip) => {
        let user = data.users.find(u => u.device_id === device_id);
        if (user) {
            user.current_ip = current_ip;
            save();
        }
    },

    getUserByDeviceId: (device_id) => data.users.find(u => u.device_id === device_id),
    
    getUserByIp: (ip) => data.users.find(u => u.current_ip === ip),

    setNotification: (id, message) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.pending_notification = message;
            save();
            return true;
        }
        return false;
    },

    clearNotification: (id) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            delete user.pending_notification;
            save();
            return true;
        }
        return false;
    },

    setMonitoring: (id, enabled) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.monitoring_enabled = enabled;
            save();
            return true;
        }
        return false;
    },

    getUsage: (user_id, date) => {
        let usage = data.usage.find(u => u.user_id === user_id && u.date === date);
        return usage ? usage.bytes_used : 0;
    },

    updateUsage: (user_id, date, bytes) => {
        let usage = data.usage.find(u => u.user_id === user_id && u.date === date);
        if (usage) {
            usage.bytes_used += bytes;
        } else {
            data.usage.push({ user_id, date, bytes_used: bytes });
        }
        if (data.settings.global_total_bytes_used === undefined) data.settings.global_total_bytes_used = 0;
        data.settings.global_total_bytes_used += bytes;
        save();
    },

    getWeeklyUsage: (user_id) => {
        const todayStr = getLocalDateString();
        const parts = todayStr.split('-');
        const today = new Date(parts[0], parts[1] - 1, parts[2]);
        const day = today.getDay(); // 0 = Sun, 6 = Sat
        const daysSinceSaturday = (day + 1) % 7; 
        
        let total = 0;
        for (let i = 0; i <= daysSinceSaturday; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let usage = data.usage.find(u => u.user_id === user_id && u.date === dateStr);
            if (usage) total += usage.bytes_used;
        }
        let user = data.users.find(u => u.id === user_id);
        if (user && user.weekly_offset) total += user.weekly_offset;
        return Math.max(0, total);
    },

    getUsersWithUsage: (date) => {
        return data.users.map(u => {
            let usage = data.usage.find(us => us.user_id === u.id && us.date === date);
            return {
                ...u,
                bytes_used: usage ? usage.bytes_used : 0,
                weekly_bytes_used: module.exports.getWeeklyUsage(u.id)
            };
        });
    },

    updateUserSettings: (id, status, daily_limit_mb, weekly_limit_mb) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.status = status;
            user.daily_limit_mb = parseInt(daily_limit_mb);
            if(weekly_limit_mb) user.weekly_limit_mb = parseInt(weekly_limit_mb);
            save();
            return true;
        }
        return false;
    },

    setUsageDirectly: (id, daily_bytes, weekly_bytes) => {
        const today = getLocalDateString();
        let user = data.users.find(u => u.id === parseInt(id));
        if (!user) return false;

        let usage = data.usage.find(u => u.user_id === parseInt(id) && u.date === today);
        if (usage) {
            usage.bytes_used = parseInt(daily_bytes);
        } else {
            data.usage.push({ user_id: parseInt(id), date: today, bytes_used: parseInt(daily_bytes) });
        }

        // Calculate current natural weekly usage (without offset)
        let naturalWeekly = module.exports.getWeeklyUsage(parseInt(id)) - (user.weekly_offset || 0);
        user.weekly_offset = parseInt(weekly_bytes) - naturalWeekly;
        save();
        return true;
    },

    resetUsage: (user_id, date) => {
        let usage = data.usage.find(u => u.user_id === parseInt(user_id) && u.date === date);
        if (usage) {
            usage.bytes_used = 0;
            save();
        }
    },

    resetWeeklyUsage: (user_id) => {
        const todayStr = getLocalDateString();
        const today = new Date(todayStr);
        const day = today.getDay(); // 0 = Sun, 6 = Sat
        const daysSinceSaturday = (day + 1) % 7; 
        
        for (let i = 0; i <= daysSinceSaturday; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            let usage = data.usage.find(u => u.user_id === parseInt(user_id) && u.date === dateStr);
            if (usage) usage.bytes_used = 0;
        }
        save();
    },

    updateGlobalLimit: (daily_limit, weekly_limit) => {
        const old_daily = data.settings.global_daily_limit_mb;
        const old_weekly = data.settings.global_weekly_limit_mb || (old_daily * 7);
        
        data.settings.global_daily_limit_mb = parseInt(daily_limit);
        data.settings.global_weekly_limit_mb = parseInt(weekly_limit);

        // Apply to users who hadn't been manually customized
        data.users.forEach(u => {
            if (u.daily_limit_mb === old_daily && (u.weekly_limit_mb === old_weekly || !u.weekly_limit_mb)) {
                u.daily_limit_mb = data.settings.global_daily_limit_mb;
                u.weekly_limit_mb = data.settings.global_weekly_limit_mb;
            }
        });
        save();
    },

    resetUserToDefault: (id) => {
        let user = data.users.find(u => u.id === parseInt(id));
        if (user) {
            user.daily_limit_mb = data.settings.global_daily_limit_mb;
            user.weekly_limit_mb = data.settings.global_weekly_limit_mb || (data.settings.global_daily_limit_mb * 7);
            save();
            return true;
        }
        return false;
    },

    getLocalDateString,
    
    getGlobalTotal: () => data.settings.global_total_bytes_used || 0,
    
    resetGlobalTotal: () => {
        data.settings.global_total_bytes_used = 0;
        save();
    },

    deleteUser: (id) => {
        const initialLength = data.users.length;
        data.users = data.users.filter(u => u.id !== parseInt(id));
        data.usage = data.usage.filter(u => u.user_id !== parseInt(id));
        if (data.users.length < initialLength) {
            save();
            return true;
        }
        return false;
    }
};
