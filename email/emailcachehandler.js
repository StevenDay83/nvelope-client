const { CacheHandler } = require('../cache/cachehandler.js');
const seedEmailEvent = `{"kind":8500,"created_at":1771640468,"tags":[],
"content":"{\"mailToList\":[\"4bc61a1f3f100f3e757f44b64c1221ade8b798db0abafe4b9976eda2261d1756\"],
\"mailFrom\":\"8ddbe4d204e66ad95574f1d619f768d9b6f88f3f0b9f39afcb5b6348a19496da\",
\"subjectLine\":\"Important Message From Tester\",
\"messageType\":{\"plaintext\":\"UnVubmluZyBuVmVsb3BlISEh\"}}",
"pubkey":"8ddbe4d204e66ad95574f1d619f768d9b6f88f3f0b9f39afcb5b6348a19496da",
"id":"d776c82f412fa4359491456580024dbfe86ee251b7a1109cd7ff2a5ccac03ada",
"sig":"78d6bfe028e48f93fc555ea33ab3d3a5e29dc96f394c368c3987aa15a8b47f22e8c97cb0eaf09828b1769fb2a75e31a9b1f4f8f19fb0041036ebeae51e396e3c"}`;


class EmailCacheHandler extends CacheHandler {
    constructor(emailDB){
        super();
        this.emailDatabase = emailDB;
    }

    initializeCacheSync(){
        let initializeTableCmd = `
        CREATE TABLE IF NOT EXISTS nvmessages_direct (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id TEXT,
        email_content_json TEXT,
        email_reply_to TEXT,
        email_subject_line TEXT,
        email_mail_to_list_json TEXT,
        email_external_ref_list_json TEXT,
        email_thread_id TEXT,
        email_timestamp_received INTEGER,
        email_favorite TEXT,
        nostr_event_json TEXT,
        nostr_blinded_envelope_id TEXT,
        nostr_blinded_envelope_timestamp INTEGER,
        nvelope_folder TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_folder ON nvmessages_direct(nvelope_folder);
        CREATE INDEX IF NOT EXISTS idx_email_id ON nvmessages_direct(email_id);
        CREATE INDEX IF NOT EXISTS idx_email_favorite ON nvmessages_direct(email_favorite);
        `;

        this.emailDatabase.exec(initializeTableCmd);

        // ------
        const seedEmailStatement = this.emailDatabase.prepare(
            'INSERT INTO nvmessages_direct (email_id, email_content_json, email_reply_to, email_subject_line, email_mail_to_list_json, email_external_ref_list_json,\
             email_thread_id, email_timestamp_received, email_favorite, nostr_event_json, nostr_blinded_envelope_id, nostr_blinded_envelope_timestamp, nvelope_folder) \
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
        );

        let resp = seedEmailStatement.run(
            "d776c82f412fa4359491456580024dbfe86ee251b7a1109cd7ff2a5ccac03ada",
            `"messageContent": {
            "plaintext": "Running nVelope!!!",
            "md": "",
            "html": ""
            }`,
            '',
            "Important Message From Tester",
            `[
                "4bc61a1f3f100f3e757f44b64c1221ade8b798db0abafe4b9976eda2261d1756"
            ]`,
            '[]',
            '',
            1771640468,
            'true',
            seedEmailEvent,
            '000074bac538f9ab7207513b4ce2180ce2a6271b58055b7d4c69790918a87367',
            1771640495,
            'inbox'
        );

        console.log(resp);

        // -----------------
        let initialImportQuery = this.emailDatabase.prepare('SELECT * from nvmessages_direct ORDER BY email_timestamp_received').all();

        console.log(initialImportQuery);

        for (let i = 0; i < initialImportQuery.length; i++){
            let emailRecord = initialImportQuery[i];

            super.setCacheValue(emailRecord.email_id, emailRecord);
        }
    }

    setCacheValue(value){
        if (key && typeof(key) === 'string' &&
        value && typeof(value) === 'object'){
            const setCacheValueStatement = this.emailDatabase.prepare(
            'INSERT INTO nvmessages_direct (email_id, email_content_json, email_reply_to, email_subject_line, email_mail_to_list_json, email_external_ref_list_json,\
             email_thread_id, email_timestamp_received, email_favorite, nostr_event_json, nostr_blinded_envelope_id, nostr_blinded_envelope_timestamp, nvelope_folder) \
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
            );

            const insertResp = setCacheValueStatement.run(
                value.email_id,
                value.email_content_json || '{}',
                value.email_reply_to || '',
                value.email_subject_line || '',
                value.email_mail_to_list_json || '[]',
                value.email_external_ref_list_json || '[]',
                value.email_thread_id || '',
                value.email_timestamp_received,
                value.email_favorite || 'false',
                value.nostr_event_json || '{}',
                value.nostr_blinded_envelope_id || '',
                value.nostr_blinded_envelope_timestamp != undefined ? value.nostr_blinded_envelope_timestamp : 0,
                value.nvelope_folder || 'inbox'
            );

            if (insertResp && insertResp.changes == 1){
                super.setCacheValue(insertResp.lastInsertRowid, value);
            }
        }
    }
}

module.exports.EmailCacheHandler = EmailCacheHandler;