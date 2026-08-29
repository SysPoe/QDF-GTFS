#include "GTFS.h"
#include <fstream>
#include <filesystem>
#include <vector>
#include <cstring>
#include <cstdint>
#include <algorithm>
#include <random>
#include <unistd.h>

namespace gtfs {

uint32_t GTFSData::snapshotArchHash() {
    std::string arch;
#if defined(__x86_64__) || defined(_M_X64)
    arch += "x86_64;";
#elif defined(__aarch64__) || defined(_M_ARM64)
    arch += "aarch64;";
#elif defined(__arm__)
    arch += "arm;";
#else
    arch += "unknown;";
#endif
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    arch += "le";
#else
    arch += "be";
#endif
    arch += ";";
    arch += std::to_string(sizeof(void*));
    arch += ";";
    arch += std::to_string(sizeof(StopTime));
    arch += ";";
    arch += std::to_string(sizeof(Trip));
    arch += ";";
    arch += std::to_string(sizeof(Shape));
    uint32_t h = 2166136261u;
    for (unsigned char c : arch) { h ^= c; h *= 16777619u; }
    return h;
}

static void writeU32(std::ostream& os, uint32_t v) { os.write(reinterpret_cast<char*>(&v), sizeof(v)); }
static void writeU64(std::ostream& os, uint64_t v) { os.write(reinterpret_cast<char*>(&v), sizeof(v)); }
static void writeI32(std::ostream& os, int32_t v) { os.write(reinterpret_cast<char*>(&v), sizeof(v)); }
static void writeF64(std::ostream& os, double v) { os.write(reinterpret_cast<char*>(&v), sizeof(v)); }
static void writeU8(std::ostream& os, uint8_t v) { os.write(reinterpret_cast<char*>(&v), 1); }
static bool readU32(std::istream& is, uint32_t& v) { is.read(reinterpret_cast<char*>(&v), sizeof(v)); return is.good(); }
static bool readU64(std::istream& is, uint64_t& v) { is.read(reinterpret_cast<char*>(&v), sizeof(v)); return is.good(); }
static bool readI32(std::istream& is, int32_t& v) { is.read(reinterpret_cast<char*>(&v), sizeof(v)); return is.good(); }
static bool readF64(std::istream& is, double& v) { is.read(reinterpret_cast<char*>(&v), sizeof(v)); return is.good(); }
static bool readU8(std::istream& is, uint8_t& v) { is.read(reinterpret_cast<char*>(&v), 1); return is.good(); }

static void writeString(std::ostream& os, const std::string& s) {
    writeU32(os, static_cast<uint32_t>(s.size()));
    if (!s.empty()) os.write(s.data(), s.size());
}
static bool readString(std::istream& is, std::string& s) {
    uint32_t len;
    if (!readU32(is, len)) return false;
    if (len > 20*1024*1024) return false;
    s.resize(len);
    if (len) { is.read(s.data(), len); if (!is) return false; }
    return true;
}
static void writeOptionalString(std::ostream& os, const std::optional<std::string>& v) {
    uint8_t present = v.has_value() ? 1 : 0;
    writeU8(os, present);
    if (v) writeString(os, *v);
}
static bool readOptionalString(std::istream& is, std::optional<std::string>& v) {
    uint8_t present;
    if (!readU8(is, present)) return false;
    if (present) {
        std::string s;
        if (!readString(is, s)) return false;
        v = s;
    } else v = std::nullopt;
    return true;
}

struct SnapshotHeader {
    uint32_t magic = 0x51444653;
    uint32_t version = 2;
    uint32_t archHash = 0;
    uint32_t headerSize = sizeof(SnapshotHeader);
    uint64_t fileSize = 0;
    uint32_t stringPoolCount = 0;
    uint32_t agencyCount = 0;
    uint32_t calendarCount = 0;
    uint32_t calendarDateCount = 0;
    uint32_t routeCount = 0;
    uint32_t stopCount = 0;
    uint32_t stopTimeCount = 0;
    uint32_t tripCount = 0;
    uint32_t transferCount = 0;
    uint32_t shapeCount = 0;
    uint32_t feedInfoCount = 0;
    uint32_t staticOccupancyCount = 0;
    uint32_t reserved = 0;
};

bool GTFSData::saveCompiledSnapshot(const std::string& path, std::string& error) const {
    try {
        std::filesystem::path p(path);
        std::filesystem::create_directories(p.parent_path());
        std::string tmp = path + "." + std::to_string(getpid()) + ".tmp";
        std::ofstream os(tmp, std::ios::binary);
        if (!os) { error = "cannot open temp file"; return false; }

        SnapshotHeader hdr;
        hdr.archHash = snapshotArchHash();
        // Prepare counts
        auto strings = string_pool.snapshotStrings();
        hdr.stringPoolCount = static_cast<uint32_t>(strings.size());
        hdr.agencyCount = 0;
        for (auto &kv : agencies) hdr.agencyCount += kv.second.size();
        hdr.calendarCount = 0;
        for (auto &kv : calendars) hdr.calendarCount += kv.second.size();
        hdr.calendarDateCount = 0;
        for (auto &kv1 : calendar_dates) for (auto &kv2 : kv1.second) hdr.calendarDateCount += kv2.second.size();
        hdr.routeCount = 0;
        for (auto &kv : routes) hdr.routeCount += kv.second.size();
        hdr.stopCount = 0;
        for (auto &kv : stops) hdr.stopCount += kv.second.size();
        hdr.stopTimeCount = static_cast<uint32_t>(stop_times.size());
        hdr.tripCount = 0;
        for (auto &kv : trips) hdr.tripCount += kv.second.size();
        hdr.transferCount = static_cast<uint32_t>(transfers.size());
        hdr.shapeCount = static_cast<uint32_t>(shapes.size());
        hdr.feedInfoCount = static_cast<uint32_t>(feed_info.size());
        hdr.staticOccupancyCount = static_cast<uint32_t>(static_occupancies.size());

        // Write placeholder header
        os.write(reinterpret_cast<char*>(&hdr), sizeof(hdr));
        // String pool
        writeU32(os, hdr.stringPoolCount);
        for (auto &s : strings) writeString(os, s);
        // Agencies
        writeU32(os, hdr.agencyCount);
        for (auto &feedKV : agencies) {
            for (auto &agKV : feedKV.second) {
                const Agency &a = agKV.second;
                writeString(os, a.feed_id);
                writeOptionalString(os, a.agency_id);
                writeString(os, a.agency_name);
                writeString(os, a.agency_url);
                writeString(os, a.agency_timezone);
                writeOptionalString(os, a.agency_lang);
                writeOptionalString(os, a.agency_phone);
                writeOptionalString(os, a.agency_fare_url);
                writeOptionalString(os, a.agency_email);
            }
        }
        // Calendars
        writeU32(os, hdr.calendarCount);
        for (auto &feedKV : calendars) {
            for (auto &calKV : feedKV.second) {
                const Calendar &c = calKV.second;
                writeString(os, c.feed_id);
                writeString(os, c.service_id);
                uint8_t mask = (c.monday?1:0) | (c.tuesday?2:0) | (c.wednesday?4:0) | (c.thursday?8:0) | (c.friday?16:0) | (c.saturday?32:0) | (c.sunday?64:0);
                writeU8(os, mask);
                writeString(os, c.start_date);
                writeString(os, c.end_date);
            }
        }
        // Calendar dates
        writeU32(os, hdr.calendarDateCount);
        for (auto &feedKV : calendar_dates) {
            for (auto &svcKV : feedKV.second) {
                for (auto &dateKV : svcKV.second) {
                    writeString(os, feedKV.first);
                    writeString(os, svcKV.first);
                    writeString(os, dateKV.first);
                    writeI32(os, dateKV.second);
                }
            }
        }
        // Routes
        writeU32(os, hdr.routeCount);
        for (auto &feedKV : routes) {
            for (auto &rKV : feedKV.second) {
                const Route &r = rKV.second;
                writeString(os, r.feed_id);
                writeString(os, r.route_id);
                writeOptionalString(os, r.agency_id);
                writeOptionalString(os, r.route_short_name);
                writeOptionalString(os, r.route_long_name);
                writeOptionalString(os, r.route_desc);
                writeI32(os, r.route_type);
                writeOptionalString(os, r.route_url);
                writeOptionalString(os, r.route_color);
                writeOptionalString(os, r.route_text_color);
                // optional ints
                uint8_t has = r.continuous_pickup.has_value()?1:0; writeU8(os,has); if (has) writeI32(os,*r.continuous_pickup);
                has = r.continuous_drop_off.has_value()?1:0; writeU8(os,has); if (has) writeI32(os,*r.continuous_drop_off);
                has = r.route_sort_order.has_value()?1:0; writeU8(os,has); if (has) writeI32(os,*r.route_sort_order);
                writeOptionalString(os, r.network_id);
            }
        }
        // Stops
        writeU32(os, hdr.stopCount);
        for (auto &feedKV : stops) {
            for (auto &sKV : feedKV.second) {
                const Stop &s = sKV.second;
                writeString(os, s.feed_id);
                writeString(os, s.stop_id);
                writeOptionalString(os, s.stop_code);
                writeString(os, s.stop_name);
                writeOptionalString(os, s.stop_desc);
                uint8_t hasLat = s.stop_lat.has_value()?1:0; writeU8(os,hasLat); if (hasLat) writeF64(os,*s.stop_lat);
                uint8_t hasLon = s.stop_lon.has_value()?1:0; writeU8(os,hasLon); if (hasLon) writeF64(os,*s.stop_lon);
                writeOptionalString(os, s.zone_id);
                writeOptionalString(os, s.stop_url);
                uint8_t hasLoc = s.location_type.has_value()?1:0; writeU8(os,hasLoc); if (hasLoc) writeI32(os,*s.location_type);
                writeOptionalString(os, s.parent_station);
                writeOptionalString(os, s.stop_timezone);
                uint8_t hasWheel = s.wheelchair_boarding.has_value()?1:0; writeU8(os,hasWheel); if (hasWheel) writeI32(os,*s.wheelchair_boarding);
                writeOptionalString(os, s.level_id);
                writeOptionalString(os, s.platform_code);
                writeOptionalString(os, s.tts_stop_name);
            }
        }
        // StopTimes (raw POD)
        writeU32(os, hdr.stopTimeCount);
        if (!stop_times.empty()) {
            os.write(reinterpret_cast<const char*>(stop_times.data()), sizeof(StopTime)*stop_times.size());
        }
        // Trips (raw POD)
        writeU32(os, hdr.tripCount);
        for (auto &feedKV : trips) {
            for (auto &tKV : feedKV.second) {
                const Trip &t = tKV.second;
                os.write(reinterpret_cast<const char*>(&t), sizeof(Trip));
            }
        }
        // Transfers
        writeU32(os, hdr.transferCount);
        for (auto &tr : transfers) {
            writeOptionalString(os, tr.from_stop_id);
            writeOptionalString(os, tr.to_stop_id);
            writeOptionalString(os, tr.from_route_id);
            writeOptionalString(os, tr.to_route_id);
            writeOptionalString(os, tr.from_trip_id);
            writeOptionalString(os, tr.to_trip_id);
            writeI32(os, tr.transfer_type);
            uint8_t has = tr.min_transfer_time.has_value()?1:0; writeU8(os,has); if (has) writeI32(os,*tr.min_transfer_time);
            writeString(os, tr.feed_id);
        }
        // Shapes (raw)
        writeU32(os, hdr.shapeCount);
        if (!shapes.empty()) os.write(reinterpret_cast<const char*>(shapes.data()), sizeof(Shape)*shapes.size());
        // FeedInfo
        writeU32(os, hdr.feedInfoCount);
        for (auto &f : feed_info) {
            writeString(os, f.feed_id);
            writeString(os, f.feed_publisher_name);
            writeString(os, f.feed_publisher_url);
            writeString(os, f.feed_lang);
            writeOptionalString(os, f.default_lang);
            writeOptionalString(os, f.feed_start_date);
            writeOptionalString(os, f.feed_end_date);
            writeOptionalString(os, f.feed_version);
            writeOptionalString(os, f.feed_contact_email);
            writeOptionalString(os, f.feed_contact_url);
        }
        // Static occupancies (raw)
        writeU32(os, hdr.staticOccupancyCount);
        if (!static_occupancies.empty()) os.write(reinterpret_cast<const char*>(static_occupancies.data()), sizeof(StaticOccupancy)*static_occupancies.size());

        os.flush();
        uint64_t fileSize = os.tellp();
        hdr.fileSize = fileSize;
        // Rewrite header with fileSize
        os.seekp(0);
        os.write(reinterpret_cast<char*>(&hdr), sizeof(hdr));
        os.close();
        // atomic rename
        std::filesystem::rename(tmp, path);
        return true;
    } catch (std::exception& e) { error = e.what(); return false; }
}

bool GTFSData::loadCompiledSnapshot(const std::string& path, std::string& error) {
    try {
        std::ifstream is(path, std::ios::binary);
        if (!is) { error = "cannot open snapshot file"; return false; }
        is.seekg(0, std::ios::end);
        uint64_t fileSize = is.tellg();
        is.seekg(0, std::ios::beg);
        if (fileSize < sizeof(SnapshotHeader)) { error = "file too small"; return false; }
        SnapshotHeader hdr;
        is.read(reinterpret_cast<char*>(&hdr), sizeof(hdr));
        if (!is) { error = "cannot read header"; return false; }
        if (hdr.magic != 0x51444653) { error = "invalid magic"; return false; }
        if (hdr.version < 2 || hdr.version > 3) { error = "incompatible version"; return false; }
        if (hdr.archHash != snapshotArchHash()) { error = "incompatible arch"; return false; }
        if (hdr.fileSize != fileSize) { error = "file size mismatch"; return false; }
        if (hdr.headerSize != sizeof(SnapshotHeader)) { error = "header size mismatch"; return false; }
        // Bounds checks: counts * size should not exceed fileSize
        // We'll proceed reading with checks

        clear(); // clear any existing data but keep string_pool separate handling
        // String pool
        uint32_t sc;
        if (!readU32(is, sc)) { error="cannot read string pool count"; return false; }
        if (sc != hdr.stringPoolCount) { error="string pool count mismatch"; return false; }
        if (sc > 5'000'000) { error="string pool too large"; return false; }
        std::vector<std::string> strings;
        strings.reserve(sc);
        for (uint32_t i=0;i<sc;i++) {
            std::string s;
            if (!readString(is, s)) { error="failed to read string pool entry"; return false; }
            strings.push_back(std::move(s));
        }
        string_pool.restoreStrings(strings);

        // Agencies
        uint32_t ac;
        if (!readU32(is, ac)) { error="cannot read agency count"; return false; }
        if (ac != hdr.agencyCount) { error="agency count mismatch"; return false; }
        for (uint32_t i=0;i<ac;i++) {
            Agency a;
            if (!readString(is, a.feed_id)) return false;
            if (!readOptionalString(is, a.agency_id)) return false;
            if (!readString(is, a.agency_name)) return false;
            if (!readString(is, a.agency_url)) return false;
            if (!readString(is, a.agency_timezone)) return false;
            if (!readOptionalString(is, a.agency_lang)) return false;
            if (!readOptionalString(is, a.agency_phone)) return false;
            if (!readOptionalString(is, a.agency_fare_url)) return false;
            if (!readOptionalString(is, a.agency_email)) return false;
            std::string key = a.agency_id.has_value()? *a.agency_id : a.agency_name;
            if (!a.agency_id) a.agency_id = key;
            agencies[a.feed_id][key] = std::move(a);
        }
        // Calendars
        uint32_t cc;
        if (!readU32(is, cc)) { error="cannot read calendar count"; return false; }
        if (cc != hdr.calendarCount) { error="calendar count mismatch"; return false; }
        for (uint32_t i=0;i<cc;i++) {
            Calendar c;
            if (!readString(is, c.feed_id)) return false;
            if (!readString(is, c.service_id)) return false;
            uint8_t mask;
            if (!readU8(is, mask)) return false;
            c.monday = mask & 1; c.tuesday = mask & 2; c.wednesday = mask & 4; c.thursday = mask & 8; c.friday = mask & 16; c.saturday = mask & 32; c.sunday = mask & 64;
            if (!readString(is, c.start_date)) return false;
            if (!readString(is, c.end_date)) return false;
            calendars[c.feed_id][c.service_id] = std::move(c);
        }
        // Calendar dates
        uint32_t cdc;
        if (!readU32(is, cdc)) { error="cannot read calendar date count"; return false; }
        if (cdc != hdr.calendarDateCount) { error="calendar date count mismatch"; return false; }
        for (uint32_t i=0;i<cdc;i++) {
            std::string feed_id, service_id, date;
            int32_t exc;
            if (!readString(is, feed_id)) return false;
            if (!readString(is, service_id)) return false;
            if (!readString(is, date)) return false;
            if (!readI32(is, exc)) return false;
            calendar_dates[feed_id][service_id][date] = exc;
        }
        // Routes
        uint32_t rc;
        if (!readU32(is, rc)) { error="cannot read route count"; return false; }
        if (rc != hdr.routeCount) { error="route count mismatch"; return false; }
        for (uint32_t i=0;i<rc;i++) {
            Route r;
            if (!readString(is, r.feed_id)) return false;
            if (!readString(is, r.route_id)) return false;
            if (!readOptionalString(is, r.agency_id)) return false;
            if (!readOptionalString(is, r.route_short_name)) return false;
            if (!readOptionalString(is, r.route_long_name)) return false;
            if (!readOptionalString(is, r.route_desc)) return false;
            if (!readI32(is, r.route_type)) return false;
            if (!readOptionalString(is, r.route_url)) return false;
            if (!readOptionalString(is, r.route_color)) return false;
            if (!readOptionalString(is, r.route_text_color)) return false;
            uint8_t has;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; r.continuous_pickup=v; } else r.continuous_pickup=std::nullopt;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; r.continuous_drop_off=v; } else r.continuous_drop_off=std::nullopt;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; r.route_sort_order=v; } else r.route_sort_order=std::nullopt;
            if (!readOptionalString(is, r.network_id)) return false;
            routes[r.feed_id][r.route_id] = std::move(r);
        }
        // Stops
        uint32_t stc;
        if (!readU32(is, stc)) { error="cannot read stop count"; return false; }
        if (stc != hdr.stopCount) { error="stop count mismatch"; return false; }
        for (uint32_t i=0;i<stc;i++) {
            Stop s;
            if (!readString(is, s.feed_id)) return false;
            if (!readString(is, s.stop_id)) return false;
            if (!readOptionalString(is, s.stop_code)) return false;
            if (!readString(is, s.stop_name)) return false;
            if (!readOptionalString(is, s.stop_desc)) return false;
            uint8_t has;
            if (!readU8(is, has)) return false;
            if (has) { double v; if(!readF64(is,v)) return false; s.stop_lat=v; } else s.stop_lat=std::nullopt;
            if (!readU8(is, has)) return false;
            if (has) { double v; if(!readF64(is,v)) return false; s.stop_lon=v; } else s.stop_lon=std::nullopt;
            if (!readOptionalString(is, s.zone_id)) return false;
            if (!readOptionalString(is, s.stop_url)) return false;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; s.location_type=v; } else s.location_type=std::nullopt;
            if (!readOptionalString(is, s.parent_station)) return false;
            if (!readOptionalString(is, s.stop_timezone)) return false;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; s.wheelchair_boarding=v; } else s.wheelchair_boarding=std::nullopt;
            if (!readOptionalString(is, s.level_id)) return false;
            if (!readOptionalString(is, s.platform_code)) return false;
            if (!readOptionalString(is, s.tts_stop_name)) return false;
            stops[s.feed_id][s.stop_id] = std::move(s);
        }
        // StopTimes
        uint32_t sttc;
        if (!readU32(is, sttc)) { error="cannot read stop time count"; return false; }
        if (sttc != hdr.stopTimeCount) { error="stop time count mismatch"; return false; }
        stop_times.resize(sttc);
        if (sttc) {
            is.read(reinterpret_cast<char*>(stop_times.data()), sizeof(StopTime)*sttc);
            if (!is) { error="failed to read stop times"; return false; }
        }
        // Trips
        uint32_t tc;
        if (!readU32(is, tc)) { error="cannot read trip count"; return false; }
        if (tc != hdr.tripCount) { error="trip count mismatch"; return false; }
        for (uint32_t i=0;i<tc;i++) {
            Trip t;
            is.read(reinterpret_cast<char*>(&t), sizeof(Trip));
            if (!is) { error="failed to read trip"; return false; }
            trips[t.feed_id][t.trip_id] = t;
        }
        // Transfers
        uint32_t trc;
        if (!readU32(is, trc)) { error="cannot read transfer count"; return false; }
        if (trc != hdr.transferCount) { error="transfer count mismatch"; return false; }
        transfers.clear(); transfers.reserve(trc);
        for (uint32_t i=0;i<trc;i++) {
            Transfer tr;
            if (!readOptionalString(is, tr.from_stop_id)) return false;
            if (!readOptionalString(is, tr.to_stop_id)) return false;
            if (!readOptionalString(is, tr.from_route_id)) return false;
            if (!readOptionalString(is, tr.to_route_id)) return false;
            if (!readOptionalString(is, tr.from_trip_id)) return false;
            if (!readOptionalString(is, tr.to_trip_id)) return false;
            if (!readI32(is, tr.transfer_type)) return false;
            uint8_t has;
            if (!readU8(is, has)) return false;
            if (has) { int32_t v; if(!readI32(is,v)) return false; tr.min_transfer_time=v; } else tr.min_transfer_time=std::nullopt;
            if (!readString(is, tr.feed_id)) return false;
            transfers.push_back(std::move(tr));
        }
        // Shapes
        uint32_t shc;
        if (!readU32(is, shc)) { error="cannot read shape count"; return false; }
        if (shc != hdr.shapeCount) { error="shape count mismatch"; return false; }
        shapes.resize(shc);
        if (shc) { is.read(reinterpret_cast<char*>(shapes.data()), sizeof(Shape)*shc); if (!is) { error="failed to read shapes"; return false; } }
        // FeedInfo
        uint32_t fic;
        if (!readU32(is, fic)) { error="cannot read feed info count"; return false; }
        if (fic != hdr.feedInfoCount) { error="feed info count mismatch"; return false; }
        feed_info.clear(); feed_info.reserve(fic);
        for (uint32_t i=0;i<fic;i++) {
            FeedInfo f;
            if (!readString(is, f.feed_id)) return false;
            if (!readString(is, f.feed_publisher_name)) return false;
            if (!readString(is, f.feed_publisher_url)) return false;
            if (!readString(is, f.feed_lang)) return false;
            if (!readOptionalString(is, f.default_lang)) return false;
            if (!readOptionalString(is, f.feed_start_date)) return false;
            if (!readOptionalString(is, f.feed_end_date)) return false;
            if (!readOptionalString(is, f.feed_version)) return false;
            if (!readOptionalString(is, f.feed_contact_email)) return false;
            if (!readOptionalString(is, f.feed_contact_url)) return false;
            feed_info.push_back(std::move(f));
        }
        // Static occupancies
        uint32_t soc;
        if (!readU32(is, soc)) { error="cannot read static occupancy count"; return false; }
        if (soc != hdr.staticOccupancyCount) { error="static occupancy count mismatch"; return false; }
        static_occupancies.resize(soc);
        if (soc) { is.read(reinterpret_cast<char*>(static_occupancies.data()), sizeof(StaticOccupancy)*soc); if (!is){ error="failed to read static occupancies"; return false; } }

        // Rebuild derived indexes
        rebuildStopTimeIndexes();
        for (auto &kv : static_occupancies) {
            // Not needed: static_occupancies_by_trip_id rebuilt similarly as in parser
        }
        if (!static_occupancies.empty()) {
            for (size_t i=0;i<static_occupancies.size();++i) static_occupancies_by_trip_id[static_occupancies[i].trip_id].push_back(i);
        }
        // Trip indexes
        for (auto &feedKV : trips) for (auto &tripKV : feedKV.second) {
            const Trip& t = tripKV.second;
            trips_by_route_id[t.feed_id][t.route_id].push_back(&tripKV.second);
            trips_by_service_id[t.feed_id][t.service_id].push_back(&tripKV.second);
            if (t.block_id != 0xFFFFFFFFu) trips_by_block_id[t.feed_id][t.block_id].push_back(&tripKV.second);
        }
        // Shape ranges
        {
            std::unordered_map<uint64_t, std::vector<Shape>> tmp;
            for (auto &s : shapes) {
                uint64_t key = (static_cast<uint64_t>(s.feed_id)<<32)|s.shape_id;
                tmp[key].push_back(s);
            }
            shapes.clear();
            shape_ranges_by_id.clear();
            size_t total=0; for(auto &kv:tmp) total+=kv.second.size();
            shapes.reserve(total);
            for (auto &kv: tmp) {
                auto &vec = kv.second;
                std::sort(vec.begin(), vec.end(), [](auto& a, auto& b){return a.shape_pt_sequence < b.shape_pt_sequence;});
                size_t begin = shapes.size();
                shapes.insert(shapes.end(), vec.begin(), vec.end());
                uint32_t sid = vec.front().shape_id;
                shape_ranges_by_id[sid].push_back({begin, shapes.size()});
            }
        }

        // Validate
        std::string verr;
        if (!validate(verr)) { error = "validation failed: " + verr; return false; }
        return true;
    } catch (std::exception& e) { error = e.what(); return false; }
}

}
