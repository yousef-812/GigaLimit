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
    } catch (e) {
        console.error('Error reading db file, starting fresh.');
    }
}

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
                user = {
                    id: data.users.length + 1,
                    name,
                    device_id,
                    current_ip: ip,
                    daily_limit_mb: default_limit,
                    weekly_limit_mb: default_limit * 7,
                    status: 'active',
                    registered_at: new Date().toISOString()
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
        save();
    },

    getWeeklyUsage: (user_id) => {
        const today = new Date();
        let total = 0;
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            let usage = data.usage.find(u => u.user_id === user_id && u.date === dateStr);
            if (usage) total += usage.bytes_used;
        }
        return total;
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

    resetUsage: (user_id, date) => {
        let usage = data.usage.find(u => u.user_id === parseInt(user_id) && u.date === date);
        if (usage) {
            usage.bytes_used = 0;
            save();
        }
    },

    updateGlobalLimit: (limit) => {
        data.settings.global_daily_limit_mb = parseInt(limit);
        save();
    }
};
