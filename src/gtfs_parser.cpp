#include "GTFS.h"
#include "miniz.h"
#include <algorithm>
#include <string.h>
#include <cstdlib>
#include <cstdio>
#include <functional>
#include <thread>
#include <future>
#include <vector>
#include <atomic>
#include <unordered_set>
#include <chrono>
#include <string_view>

namespace gtfs {

using LogFn = std::function<void(const std::string&)>;
using ProgressFn = std::function<void(std::string task, int64_t current, int64_t total)>;


// Emit progress roughly every 64KB processed per file
constexpr size_t PROGRESS_CHUNK_BYTES = 64 * 1024;


// Helper to remove UTF-8 BOM if present
void remove_bom(std::string& line) {
    if (line.size() >= 3 && 
        static_cast<unsigned char>(line[0]) == 0xEF && 
        static_cast<unsigned char>(line[1]) == 0xBB && 
        static_cast<unsigned char>(line[2]) == 0xBF) {
        line.erase(0, 3);
    }
}


// Helper to convert "HH:MM:SS" to seconds
int parse_time_seconds(const std::string& time_str) {
    if (time_str.empty()) return -1;
    const char* ptr = time_str.c_str();

    while (*ptr == ' ') ptr++;

    int h = 0, m = 0, s = 0;

    if (*ptr < '0' || *ptr > '9') return -1;
    while (*ptr >= '0' && *ptr <= '9') {
        h = h * 10 + (*ptr - '0');
        ptr++;
    }
    if (*ptr != ':') return -1;
    ptr++;


    if (*ptr < '0' || *ptr > '9') return -1;
    while (*ptr >= '0' && *ptr <= '9') {
        m = m * 10 + (*ptr - '0');
        ptr++;
    }
    if (*ptr != ':') return -1;
    ptr++;


    if (*ptr < '0' || *ptr > '9') return -1;
    while (*ptr >= '0' && *ptr <= '9') {
        s = s * 10 + (*ptr - '0');
        ptr++;
    }


    if (m < 0 || m > 59 || s < 0 || s > 59) return -1;
    return h * 3600 + m * 60 + s;
}

int parse_time_seconds_view(const char* data, size_t len) {
    if (!data || len == 0) return -1;
    const char* ptr = data;
    const char* end = data + len;

    while (ptr < end && *ptr == ' ') ptr++;

    int h = 0, m = 0, s = 0;

    if (ptr >= end || *ptr < '0' || *ptr > '9') return -1;
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        h = h * 10 + (*ptr - '0');
        ptr++;
    }
    if (ptr >= end || *ptr != ':') return -1;
    ptr++;

    if (ptr >= end || *ptr < '0' || *ptr > '9') return -1;
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        m = m * 10 + (*ptr - '0');
        ptr++;
    }
    if (ptr >= end || *ptr != ':') return -1;
    ptr++;

    if (ptr >= end || *ptr < '0' || *ptr > '9') return -1;
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        s = s * 10 + (*ptr - '0');
        ptr++;
    }

    if (m < 0 || m > 59 || s < 0 || s > 59) return -1;
    return h * 3600 + m * 60 + s;
}

int parse_int_view(const char* data, size_t len, int default_val = 0) {
    if (!data || len == 0) return default_val;
    const char* ptr = data;
    const char* end = data + len;

    while (ptr < end && *ptr == ' ') ++ptr;

    int sign = 1;
    if (ptr < end && *ptr == '-') {
        sign = -1;
        ++ptr;
    } else if (ptr < end && *ptr == '+') {
        ++ptr;
    }

    int result = 0;
    bool has_digits = false;
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        has_digits = true;
        result = result * 10 + (*ptr - '0');
        ++ptr;
    }

    if (!has_digits) return default_val;
    return result * sign;
}

bool parse_double_view(const char* data, size_t len, double& out) {
    if (!data || len == 0) return false;
    char buf[32];
    if (len >= sizeof(buf)) len = sizeof(buf) - 1;
    memcpy(buf, data, len);
    buf[len] = '\0';
    char* endp = nullptr;
    out = std::strtod(buf, &endp);
    return endp != buf;
}


// Advance past the next newline; sets line_start/line_len (without \r\n)
static inline const char* advance_line(const char* ptr, const char* end, const char*& line_start, size_t& line_len) {
    line_start = ptr;
    const char* nl = static_cast<const char*>(memchr(ptr, '\n', static_cast<size_t>(end - ptr)));
    if (!nl) {
        line_len = static_cast<size_t>(end - ptr);
        return end;
    }
    line_len = static_cast<size_t>(nl - ptr);
    if (line_len > 0 && ptr[line_len - 1] == '\r') line_len--;
    return nl + 1;
}


// Improved CSV parser
std::vector<std::string> parse_csv_line(const std::string& line) {
    std::vector<std::string> result;

    result.reserve(16); 
    std::string cell;
    cell.reserve(64);

    bool inside_quotes = false;
    for (size_t i = 0; i < line.length(); ++i) {
        char c = line[i];
        if (c == '"') {
            if (inside_quotes && i + 1 < line.length() && line[i+1] == '"') {
        cell += '"';
                i++;
            } else {
                inside_quotes = !inside_quotes;
            }
        } else if (c == ',' && !inside_quotes) {
            result.push_back(std::move(cell));

            cell.clear(); 
        } else if (c == '\r') {
             continue;
        } else {
            cell += c;
        }
    }
    result.push_back(std::move(cell));
    return result;
}

int get_col_index(const std::vector<std::string>& headers, const std::string& name) {
    auto it = std::find(headers.begin(), headers.end(), name);
    if (it != headers.end()) {
        return std::distance(headers.begin(), it);
    }
    return -1;
}

std::string get_val(const std::vector<std::string>& row, int index, const std::string& default_val = "") {
    if (index >= 0 && index < (int)row.size()) {
        return row[index];
    }
    return default_val;
}

int get_int(const std::vector<std::string>& row, int index, int default_val = 0) {
    if (index < 0 || index >= (int)row.size()) return default_val;
    const std::string& val = row[index];
    if (val.empty()) return default_val;
    return parse_int_view(val.data(), val.size(), default_val);
}

double get_double(const std::vector<std::string>& row, int index, double default_val = 0.0) {
    if (index < 0 || index >= (int)row.size()) return default_val;
    const std::string& val = row[index];
    if (val.empty()) return default_val;
    double out = default_val;
    parse_double_view(val.data(), val.size(), out);
    return out;
}

bool get_bool(const std::vector<std::string>& row, int index, bool default_val = false) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    return val == "1";
}


size_t parse_agency(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int id_idx = get_col_index(headers, "agency_id");
    int name_idx = get_col_index(headers, "agency_name");
    int url_idx = get_col_index(headers, "agency_url");
    int tz_idx = get_col_index(headers, "agency_timezone");
    int lang_idx = get_col_index(headers, "agency_lang");
    int phone_idx = get_col_index(headers, "agency_phone");
    int fare_url_idx = get_col_index(headers, "agency_fare_url");
    int email_idx = get_col_index(headers, "agency_email");

    data.agencies[feed_id].reserve(content_size / 80 + 16);

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Agency a;
        a.feed_id = feed_id;
        std::string tmp;
        tmp = get_val(row, id_idx);
        if (!tmp.empty()) a.agency_id = tmp;
        a.agency_name = get_val(row, name_idx);
        a.agency_url = get_val(row, url_idx);
        a.agency_timezone = get_val(row, tz_idx);
        tmp = get_val(row, lang_idx);
        if (!tmp.empty()) a.agency_lang = tmp;
        tmp = get_val(row, phone_idx);
        if (!tmp.empty()) a.agency_phone = tmp;
        tmp = get_val(row, fare_url_idx);
        if (!tmp.empty()) a.agency_fare_url = tmp;
        tmp = get_val(row, email_idx);
        if (!tmp.empty()) a.agency_email = tmp;

        std::string key = a.agency_id.has_value() ? a.agency_id.value() : a.agency_name;
        if (!a.agency_id.has_value()) a.agency_id = key;

        if (merge_strategy == 1 && data.agencies[feed_id].count(key)) continue;
        if (merge_strategy == 2 && data.agencies[feed_id].count(key)) throw std::runtime_error("Duplicate agency: " + key);

        data.agencies[feed_id][key] = a;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_routes(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int id_idx = get_col_index(headers, "route_id");
    int agency_id_idx = get_col_index(headers, "agency_id");
    int short_name_idx = get_col_index(headers, "route_short_name");
    int long_name_idx = get_col_index(headers, "route_long_name");
    int desc_idx = get_col_index(headers, "route_desc");
    int type_idx = get_col_index(headers, "route_type");
    int url_idx = get_col_index(headers, "route_url");
    int color_idx = get_col_index(headers, "route_color");
    int text_color_idx = get_col_index(headers, "route_text_color");
    int cont_pickup_idx = get_col_index(headers, "continuous_pickup");
    int cont_drop_off_idx = get_col_index(headers, "continuous_drop_off");
    int sort_order_idx = get_col_index(headers, "route_sort_order");
    int network_id_idx = get_col_index(headers, "network_id");

    data.routes[feed_id].reserve(content_size / 100 + 16);

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Route r;
        r.feed_id = feed_id;
        std::string tmp;
        r.route_id = get_val(row, id_idx);
        tmp = get_val(row, agency_id_idx);
        if (!tmp.empty()) r.agency_id = tmp;
        tmp = get_val(row, short_name_idx);
        if (!tmp.empty()) r.route_short_name = tmp;
        tmp = get_val(row, long_name_idx);
        if (!tmp.empty()) r.route_long_name = tmp;
        tmp = get_val(row, desc_idx);
        if (!tmp.empty()) r.route_desc = tmp;
        r.route_type = get_int(row, type_idx);
        tmp = get_val(row, url_idx);
        if (!tmp.empty()) r.route_url = tmp;
        tmp = get_val(row, color_idx);
        if (!tmp.empty()) r.route_color = tmp;
        tmp = get_val(row, text_color_idx);
        if (!tmp.empty()) r.route_text_color = tmp;
        tmp = get_val(row, cont_pickup_idx);
        if (!tmp.empty()) r.continuous_pickup = get_int(row, cont_pickup_idx);
        tmp = get_val(row, cont_drop_off_idx);
        if (!tmp.empty()) r.continuous_drop_off = get_int(row, cont_drop_off_idx);
        tmp = get_val(row, sort_order_idx);
        if (!tmp.empty()) r.route_sort_order = get_int(row, sort_order_idx);
        tmp = get_val(row, network_id_idx);
        if (!tmp.empty()) r.network_id = tmp;

        if (merge_strategy == 1 && data.routes[feed_id].count(r.route_id)) continue;
        if (merge_strategy == 2 && data.routes[feed_id].count(r.route_id)) throw std::runtime_error("Duplicate route: " + r.route_id);

        data.routes[feed_id][r.route_id] = r;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_trips(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int route_id_idx = get_col_index(headers, "route_id");
    int service_id_idx = get_col_index(headers, "service_id");
    int trip_id_idx = get_col_index(headers, "trip_id");
    int headsign_idx = get_col_index(headers, "trip_headsign");
    int short_name_idx = get_col_index(headers, "trip_short_name");
    int direction_id_idx = get_col_index(headers, "direction_id");
    int block_id_idx = get_col_index(headers, "block_id");
    int shape_id_idx = get_col_index(headers, "shape_id");
    int wheelchair_idx = get_col_index(headers, "wheelchair_accessible");
    int bikes_idx = get_col_index(headers, "bikes_allowed");

    data.trips[feed_id].reserve(content_size / 80 + 16);

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Trip t;
        t.feed_id = feed_id;
        std::string tmp;
        t.route_id = get_val(row, route_id_idx);
        t.service_id = get_val(row, service_id_idx);
        t.trip_id = get_val(row, trip_id_idx);
        tmp = get_val(row, headsign_idx);
        if (!tmp.empty()) t.trip_headsign = tmp;
        tmp = get_val(row, short_name_idx);
        if (!tmp.empty()) t.trip_short_name = tmp;
        tmp = get_val(row, direction_id_idx);
        if (!tmp.empty()) t.direction_id = get_int(row, direction_id_idx);
        tmp = get_val(row, block_id_idx);
        if (!tmp.empty()) t.block_id = tmp;
        tmp = get_val(row, shape_id_idx);
        if (!tmp.empty()) t.shape_id = tmp;
        tmp = get_val(row, wheelchair_idx);
        if (!tmp.empty()) t.wheelchair_accessible = get_int(row, wheelchair_idx);
        tmp = get_val(row, bikes_idx);
        if (!tmp.empty()) t.bikes_allowed = get_int(row, bikes_idx);

        if (merge_strategy == 1 && data.trips[feed_id].count(t.trip_id)) continue;
        if (merge_strategy == 2 && data.trips[feed_id].count(t.trip_id)) throw std::runtime_error("Duplicate trip: " + t.trip_id);

        data.trips[feed_id][t.trip_id] = t;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_stops(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int id_idx = get_col_index(headers, "stop_id");
    int code_idx = get_col_index(headers, "stop_code");
    int name_idx = get_col_index(headers, "stop_name");
    int desc_idx = get_col_index(headers, "stop_desc");
    int lat_idx = get_col_index(headers, "stop_lat");
    int lon_idx = get_col_index(headers, "stop_lon");
    int zone_idx = get_col_index(headers, "zone_id");
    int url_idx = get_col_index(headers, "stop_url");
    int loc_type_idx = get_col_index(headers, "location_type");
    int parent_idx = get_col_index(headers, "parent_station");
    int tz_idx = get_col_index(headers, "stop_timezone");
    int wheelchair_idx = get_col_index(headers, "wheelchair_boarding");
    int level_idx = get_col_index(headers, "level_id");
    int platform_idx = get_col_index(headers, "platform_code");

    data.stops[feed_id].reserve(content_size / 80 + 16);

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Stop s;
        s.feed_id = feed_id;
        std::string tmp;
        s.stop_id = get_val(row, id_idx);
        tmp = get_val(row, code_idx);
        if (!tmp.empty()) s.stop_code = tmp;
        s.stop_name = get_val(row, name_idx);
        tmp = get_val(row, desc_idx);
        if (!tmp.empty()) s.stop_desc = tmp;
        tmp = get_val(row, lat_idx);
        if (!tmp.empty()) s.stop_lat = get_double(row, lat_idx);
        tmp = get_val(row, lon_idx);
        if (!tmp.empty()) s.stop_lon = get_double(row, lon_idx);
        tmp = get_val(row, zone_idx);
        if (!tmp.empty()) s.zone_id = tmp;
        tmp = get_val(row, url_idx);
        if (!tmp.empty()) s.stop_url = tmp;
        tmp = get_val(row, loc_type_idx);
        if (!tmp.empty()) s.location_type = get_int(row, loc_type_idx);
        tmp = get_val(row, parent_idx);
        if (!tmp.empty()) s.parent_station = tmp;
        tmp = get_val(row, tz_idx);
        if (!tmp.empty()) s.stop_timezone = tmp;
        tmp = get_val(row, wheelchair_idx);
        if (!tmp.empty()) s.wheelchair_boarding = get_int(row, wheelchair_idx);
        tmp = get_val(row, level_idx);
        if (!tmp.empty()) s.level_id = tmp;
        tmp = get_val(row, platform_idx);
        if (!tmp.empty()) s.platform_code = tmp;

        if (merge_strategy == 1 && data.stops[feed_id].count(s.stop_id)) continue;
        if (merge_strategy == 2 && data.stops[feed_id].count(s.stop_id)) throw std::runtime_error("Duplicate stop: " + s.stop_id);

        data.stops[feed_id][s.stop_id] = s;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}


// Updated to output to a specific vector, useful for multithreading
size_t parse_stop_times_chunk(StringPool& string_pool, const char* start, size_t length, const std::vector<std::string>& headers, uint32_t feed_id, std::vector<StopTime>& out_vec, const std::function<void(size_t)>& on_progress = nullptr) {
    int trip_id_idx = get_col_index(headers, "trip_id");
    int arrival_idx = get_col_index(headers, "arrival_time");
    int departure_idx = get_col_index(headers, "departure_time");
    int stop_id_idx = get_col_index(headers, "stop_id");
    int seq_idx = get_col_index(headers, "stop_sequence");
    int headsign_idx = get_col_index(headers, "stop_headsign");
    int pickup_idx = get_col_index(headers, "pickup_type");
    int drop_off_idx = get_col_index(headers, "drop_off_type");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");
    int timepoint_idx = get_col_index(headers, "timepoint");
    int cont_pickup_idx = get_col_index(headers, "continuous_pickup");
    int cont_drop_off_idx = get_col_index(headers, "continuous_drop_off");

    size_t bytes_read = 0;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            size_t delta = bytes - last_report;
            on_progress(delta);
            last_report += delta;
        }
    };

    std::vector<std::pair<const char*, size_t>> row;
    row.reserve(headers.size());

    const char* ptr = start;
    const char* end = start + length;

    size_t count = 0;
    while (ptr < end) {
        const char* line_start = ptr;
        const char* line_end = static_cast<const char*>(memchr(ptr, '\n', static_cast<size_t>(end - ptr)));
        if (!line_end) {
            line_end = end;
        }
        ptr = line_end;
        if (ptr < end) ++ptr;

        size_t raw_len = static_cast<size_t>(line_end - line_start);
        bytes_read += raw_len;
        if (line_end < end) bytes_read += 1;
        if (raw_len == 0) {
            report_progress(bytes_read);
            continue;
        }

        size_t parse_len = raw_len;
        if (parse_len > 0 && line_start[parse_len - 1] == '\r') {
            parse_len--;
        }
        if (parse_len == 0) {
            report_progress(bytes_read);
            continue;
        }

        const void* quote_pos = memchr(line_start, '"', parse_len);
        if (quote_pos) {
            // Quoted path: fall back to string-based CSV parser
            std::string line(line_start, parse_len);
            auto row_str = parse_csv_line(line);

            StopTime st;
            st.feed_id = feed_id;
            st.trip_id = string_pool.intern(get_val(row_str, trip_id_idx));
            {
                int t = parse_time_seconds(get_val(row_str, arrival_idx));
                st.arrival_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
            }
            {
                int t = parse_time_seconds(get_val(row_str, departure_idx));
                st.departure_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
            }
            st.stop_id = string_pool.intern(get_val(row_str, stop_id_idx));
            st.stop_sequence = get_int(row_str, seq_idx);
            {
                const std::string& hs = get_val(row_str, headsign_idx);
                st.stop_headsign = hs.empty() ? ST_NO_HEADSIGN : string_pool.intern(hs);
            }
            st.pickup_type   = static_cast<int8_t>(get_int(row_str, pickup_idx));
            st.drop_off_type = static_cast<int8_t>(get_int(row_str, drop_off_idx));
            {
                const std::string& dv = get_val(row_str, dist_idx);
                if (!dv.empty()) {
                    double d = 0.0;
                    st.shape_dist_traveled = parse_double_view(dv.data(), dv.size(), d) ? d : ST_NO_DIST;
                }
            }
            {
                const std::string& tv = get_val(row_str, timepoint_idx);
                st.timepoint = tv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_int(row_str, timepoint_idx));
            }
            {
                const std::string& cpv = get_val(row_str, cont_pickup_idx);
                st.continuous_pickup = cpv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_int(row_str, cont_pickup_idx));
            }
            {
                const std::string& cdv = get_val(row_str, cont_drop_off_idx);
                st.continuous_drop_off = cdv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_int(row_str, cont_drop_off_idx));
            }
            out_vec.push_back(st);
            count++;
            report_progress(bytes_read);
            continue;
        }

        // Fast path: no quotes, split by comma directly on raw buffer
        row.clear();
        const char* field_start = line_start;
        const char* line_end_ptr = line_start + parse_len;
        for (const char* p = line_start; p < line_end_ptr; ++p) {
            if (*p == ',') {
                row.emplace_back(field_start, static_cast<size_t>(p - field_start));
                field_start = p + 1;
            }
        }
        row.emplace_back(field_start, static_cast<size_t>(line_end_ptr - field_start));

        auto get_view = [&](int idx) -> std::pair<const char*, size_t> {
            if (idx < 0 || idx >= static_cast<int>(row.size())) return { nullptr, 0 };
            return row[static_cast<size_t>(idx)];
        };

        StopTime st;
        st.feed_id = feed_id;

        // Zero-copy intern: uses intern(const char*, size_t) to avoid std::string allocation
        auto trip_view = get_view(trip_id_idx);
        st.trip_id = string_pool.intern(trip_view.first, trip_view.second);

        auto arrival_view = get_view(arrival_idx);
        {
            int t = parse_time_seconds_view(arrival_view.first, arrival_view.second);
            st.arrival_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
        }
        auto departure_view = get_view(departure_idx);
        {
            int t = parse_time_seconds_view(departure_view.first, departure_view.second);
            st.departure_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
        }

        auto stop_view = get_view(stop_id_idx);
        st.stop_id = string_pool.intern(stop_view.first, stop_view.second);

        auto seq_view = get_view(seq_idx);
        st.stop_sequence = parse_int_view(seq_view.first, seq_view.second);

        auto headsign_view = get_view(headsign_idx);
        st.stop_headsign = (headsign_view.first && headsign_view.second > 0)
            ? string_pool.intern(headsign_view.first, headsign_view.second)
            : ST_NO_HEADSIGN;

        auto pickup_view = get_view(pickup_idx);
        st.pickup_type = static_cast<int8_t>(parse_int_view(pickup_view.first, pickup_view.second));
        auto drop_view = get_view(drop_off_idx);
        st.drop_off_type = static_cast<int8_t>(parse_int_view(drop_view.first, drop_view.second));

        auto dist_view = get_view(dist_idx);
        if (dist_view.first && dist_view.second > 0) {
            double dist_val = 0.0;
            st.shape_dist_traveled = parse_double_view(dist_view.first, dist_view.second, dist_val) ? dist_val : ST_NO_DIST;
        }

        auto timepoint_view = get_view(timepoint_idx);
        st.timepoint = (timepoint_view.first && timepoint_view.second > 0)
            ? static_cast<int8_t>(parse_int_view(timepoint_view.first, timepoint_view.second))
            : ST_NO_INT8;

        auto cont_pickup_view = get_view(cont_pickup_idx);
        st.continuous_pickup = (cont_pickup_view.first && cont_pickup_view.second > 0)
            ? static_cast<int8_t>(parse_int_view(cont_pickup_view.first, cont_pickup_view.second))
            : ST_NO_INT8;

        auto cont_drop_view = get_view(cont_drop_off_idx);
        st.continuous_drop_off = (cont_drop_view.first && cont_drop_view.second > 0)
            ? static_cast<int8_t>(parse_int_view(cont_drop_view.first, cont_drop_view.second))
            : ST_NO_INT8;

        out_vec.push_back(st);
        count++;
        report_progress(bytes_read);
    }

    if (on_progress && bytes_read > last_report) on_progress(bytes_read - last_report);
    return count;
}

size_t parse_calendar(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int service_id_idx = get_col_index(headers, "service_id");
    int mon_idx = get_col_index(headers, "monday");
    int tue_idx = get_col_index(headers, "tuesday");
    int wed_idx = get_col_index(headers, "wednesday");
    int thu_idx = get_col_index(headers, "thursday");
    int fri_idx = get_col_index(headers, "friday");
    int sat_idx = get_col_index(headers, "saturday");
    int sun_idx = get_col_index(headers, "sunday");
    int start_idx = get_col_index(headers, "start_date");
    int end_idx2 = get_col_index(headers, "end_date");

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Calendar c;
        c.feed_id = feed_id;
        c.service_id = get_val(row, service_id_idx);
        c.monday = get_bool(row, mon_idx);
        c.tuesday = get_bool(row, tue_idx);
        c.wednesday = get_bool(row, wed_idx);
        c.thursday = get_bool(row, thu_idx);
        c.friday = get_bool(row, fri_idx);
        c.saturday = get_bool(row, sat_idx);
        c.sunday = get_bool(row, sun_idx);
        c.start_date = get_val(row, start_idx);
        c.end_date = get_val(row, end_idx2);

        if (merge_strategy == 1 && data.calendars[feed_id].count(c.service_id)) continue;
        if (merge_strategy == 2 && data.calendars[feed_id].count(c.service_id)) throw std::runtime_error("Duplicate calendar: " + c.service_id);

        data.calendars[feed_id][c.service_id] = c;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_calendar_dates(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int service_id_idx = get_col_index(headers, "service_id");
    int date_idx = get_col_index(headers, "date");
    int exc_idx = get_col_index(headers, "exception_type");

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        std::string service_id = get_val(row, service_id_idx);
        std::string date = get_val(row, date_idx);
        int exc = get_int(row, exc_idx);

        data.calendar_dates[feed_id][service_id][date] = exc;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_shapes(GTFSData& data, std::unordered_map<std::string, std::vector<Shape>>& merged_shapes, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int id_idx = get_col_index(headers, "shape_id");
    int lat_idx = get_col_index(headers, "shape_pt_lat");
    int lon_idx = get_col_index(headers, "shape_pt_lon");
    int seq_idx = get_col_index(headers, "shape_pt_sequence");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");

    std::unordered_map<std::string, std::vector<Shape>> feed_shapes;

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Shape s;
        s.feed_id = feed_id;
        s.shape_id = get_val(row, id_idx);
        s.shape_pt_lat = get_double(row, lat_idx);
        s.shape_pt_lon = get_double(row, lon_idx);
        s.shape_pt_sequence = get_int(row, seq_idx);
        std::string tmp = get_val(row, dist_idx);
        if (!tmp.empty()) s.shape_dist_traveled = get_double(row, dist_idx);

        feed_shapes[s.shape_id].push_back(s);
        count++;
        report_progress(bytes_read);
    }

    for (auto& [id, vec] : feed_shapes) {
        if (merge_strategy == 1 && merged_shapes.count(id)) continue;
        if (merge_strategy == 2 && merged_shapes.count(id)) throw std::runtime_error("Duplicate shape: " + id);

        std::sort(vec.begin(), vec.end(), [](const Shape& a, const Shape& b){
            return a.shape_pt_sequence < b.shape_pt_sequence;
        });

        merged_shapes[id] = std::move(vec);
    }

    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_feed_info(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    (void)merge_strategy;

    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(header_str);
    int pub_name_idx = get_col_index(headers, "feed_publisher_name");
    int pub_url_idx = get_col_index(headers, "feed_publisher_url");
    int lang_idx = get_col_index(headers, "feed_lang");
    int def_lang_idx = get_col_index(headers, "default_lang");
    int start_idx = get_col_index(headers, "feed_start_date");
    int end_idx2 = get_col_index(headers, "feed_end_date");
    int ver_idx = get_col_index(headers, "feed_version");
    int email_idx = get_col_index(headers, "feed_contact_email");
    int contact_url_idx = get_col_index(headers, "feed_contact_url");

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        FeedInfo f;
        f.feed_id = feed_id;
        std::string tmp;
        f.feed_publisher_name = get_val(row, pub_name_idx);
        f.feed_publisher_url = get_val(row, pub_url_idx);
        f.feed_lang = get_val(row, lang_idx);
        tmp = get_val(row, def_lang_idx);
        if (!tmp.empty()) f.default_lang = tmp;
        tmp = get_val(row, start_idx);
        if (!tmp.empty()) f.feed_start_date = tmp;
        tmp = get_val(row, end_idx2);
        if (!tmp.empty()) f.feed_end_date = tmp;
        tmp = get_val(row, ver_idx);
        if (!tmp.empty()) f.feed_version = tmp;
        tmp = get_val(row, email_idx);
        if (!tmp.empty()) f.feed_contact_email = tmp;
        tmp = get_val(row, contact_url_idx);
        if (!tmp.empty()) f.feed_contact_url = tmp;

        data.feed_info.push_back(f);
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

void load_feeds(GTFSData& data, const std::vector<BufferView>& zip_buffers, const std::vector<std::string>& feed_ids, int merge_strategy, LogFn log, ProgressFn progress, const std::vector<std::string>& files_to_load = {}) {
    data.clear();

    std::unordered_map<uint32_t, std::vector<StopTime>> merged_stop_times;
    std::unordered_map<std::string, std::vector<Shape>> merged_shapes;

    // Build effective file filter (empty = load all)
    const std::vector<std::string> all_target_files = {
        "agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt",
        "calendar.txt", "calendar_dates.txt", "shapes.txt", "feed_info.txt"
    };
    const std::vector<std::string>& target_files = files_to_load.empty() ? all_target_files : files_to_load;

    int feed_idx = 0;
    for (const auto& zip_data : zip_buffers) {
        std::string current_feed_id = (feed_idx < (int)feed_ids.size()) ? feed_ids[feed_idx] : std::to_string(feed_idx);
        uint32_t current_feed_id_int = data.string_pool.intern(current_feed_id);

        feed_idx++;
        if (log) log("Processing feed " + current_feed_id + "...");

        mz_zip_archive zip_archive;
        memset(&zip_archive, 0, sizeof(zip_archive));

        if (!mz_zip_reader_init_mem(&zip_archive, zip_data.data, zip_data.size, 0)) {
            if (log) log("Failed to init zip reader for feed " + std::to_string(feed_idx));
            std::cerr << "Failed to init zip reader" << std::endl;
            continue;
        }

        int64_t total_uncompressed_size = 0;
        int file_count = mz_zip_reader_get_num_files(&zip_archive);

        // Extract directly into vector<char> — no extra heap copy via mz_zip_reader_extract_file_to_heap
        std::unordered_map<std::string, std::vector<char>> file_contents;

        for (int i = 0; i < file_count; i++) {
            mz_zip_archive_file_stat file_stat;
            if (!mz_zip_reader_file_stat(&zip_archive, i, &file_stat)) continue;

            std::string filename = file_stat.m_filename;
            bool is_target = false;
            for (const auto& tf : target_files) {
                if (tf == filename) { is_target = true; break; }
            }
            if (!is_target) continue;

            size_t uncomp_size = static_cast<size_t>(file_stat.m_uncomp_size);
            std::vector<char> buf(uncomp_size);
            if (mz_zip_reader_extract_to_mem(&zip_archive, i, buf.data(), uncomp_size, 0)) {
                total_uncompressed_size += static_cast<int64_t>(uncomp_size);
                file_contents[filename] = std::move(buf);
            }
        }
        mz_zip_reader_end(&zip_archive);

        std::vector<std::future<size_t>> futures;
        std::atomic<int64_t> processed_bytes(0);

        // Lambda that wraps a parser taking (GTFSData&, const char*, size_t, int, const string&, progress_fn)
        auto process_file = [&](auto parser_func, const std::string& filename) -> size_t {
            auto it = file_contents.find(filename);
            if (it == file_contents.end()) return 0;
            const std::vector<char>& vec = it->second;
            auto inline_progress = [&](size_t file_bytes_done) {
                if (!progress) return;
                int64_t current = processed_bytes.load(std::memory_order_relaxed) + static_cast<int64_t>(file_bytes_done);
                if (current > total_uncompressed_size) current = total_uncompressed_size;
                progress("Loading GTFS Data (Feed " + current_feed_id + ")", current, total_uncompressed_size);
            };

            auto t0 = std::chrono::steady_clock::now();
            size_t count = parser_func(data, vec.data(), vec.size(), merge_strategy, current_feed_id, inline_progress);
            double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            if (log) log("Parsed " + filename + " in " + std::to_string(ms) + "ms (" + std::to_string(count) + " records)");

            int64_t current = processed_bytes.fetch_add(static_cast<int64_t>(vec.size())) + static_cast<int64_t>(vec.size());
            if (progress) progress("Loading GTFS Data (Feed " + current_feed_id + ")", current, total_uncompressed_size);
            return count;
        };

        auto process_shapes_file = [&](const std::string& filename) -> size_t {
            auto it = file_contents.find(filename);
            if (it == file_contents.end()) return 0;
            const std::vector<char>& vec = it->second;
            auto inline_progress = [&](size_t file_bytes_done) {
                if (!progress) return;
                int64_t current = processed_bytes.load(std::memory_order_relaxed) + static_cast<int64_t>(file_bytes_done);
                if (current > total_uncompressed_size) current = total_uncompressed_size;
                progress("Loading GTFS Data (Feed " + current_feed_id + ")", current, total_uncompressed_size);
            };

            auto t0 = std::chrono::steady_clock::now();
            size_t count = parse_shapes(data, merged_shapes, vec.data(), vec.size(), merge_strategy, current_feed_id, inline_progress);
            double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            if (log) log("Parsed " + filename + " in " + std::to_string(ms) + "ms (" + std::to_string(count) + " records)");

            int64_t current = processed_bytes.fetch_add(static_cast<int64_t>(vec.size())) + static_cast<int64_t>(vec.size());
            if (progress) progress("Loading GTFS Data (Feed " + current_feed_id + ")", current, total_uncompressed_size);
            return count;
        };

        if (file_contents.count("agency.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_agency, "agency.txt"));
        if (file_contents.count("routes.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_routes, "routes.txt"));
        if (file_contents.count("trips.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_trips, "trips.txt"));
        if (file_contents.count("stops.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_stops, "stops.txt"));
        if (file_contents.count("calendar.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_calendar, "calendar.txt"));
        if (file_contents.count("calendar_dates.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_calendar_dates, "calendar_dates.txt"));
        if (file_contents.count("shapes.txt"))
            futures.push_back(std::async(std::launch::async, process_shapes_file, "shapes.txt"));
        if (file_contents.count("feed_info.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_feed_info, "feed_info.txt"));

        std::future<size_t> stop_times_future;
        if (file_contents.count("stop_times.txt")) {
            stop_times_future = std::async(std::launch::async,
                [&data, &file_contents, progress, log, total_uncompressed_size, &processed_bytes, &merged_stop_times, merge_strategy, current_feed_id, current_feed_id_int]() -> size_t {
                const std::vector<char>& content_vec = file_contents.at("stop_times.txt");
                if (content_vec.empty()) return 0;

                const char* content_data = content_vec.data();
                size_t content_size = content_vec.size();

                // Find header line
                const char* nl = static_cast<const char*>(memchr(content_data, '\n', content_size));
                if (!nl) return 0;
                size_t header_len = static_cast<size_t>(nl - content_data);
                if (header_len > 0 && content_data[header_len - 1] == '\r') header_len--;
                std::string header_line(content_data, header_len);
                remove_bom(header_line);
                auto headers = parse_csv_line(header_line);

                size_t start_pos = static_cast<size_t>(nl - content_data) + 1;
                if (start_pos >= content_size) return 0;

                processed_bytes.fetch_add(static_cast<int64_t>(start_pos));

                // Cap thread count at min(hardware_concurrency, 8) to prevent oversubscription
                unsigned int thread_count = std::thread::hardware_concurrency();
                if (thread_count == 0) thread_count = 4;
                if (thread_count > 8) thread_count = 8;

                size_t data_size = content_size - start_pos;
                size_t chunk_size = data_size / thread_count;

                std::vector<std::future<std::vector<StopTime>>> chunk_futures;
                size_t current_pos = start_pos;

                for (unsigned int i = 0; i < thread_count; ++i) {
                    size_t end_pos = current_pos + chunk_size;
                    if (i == thread_count - 1) {
                        end_pos = content_size;
                    } else {
                        // Advance to next newline boundary
                        const char* search_start = content_data + end_pos;
                        size_t remaining = content_size - end_pos;
                        const char* next_nl = static_cast<const char*>(memchr(search_start, '\n', remaining));
                        end_pos = next_nl ? static_cast<size_t>(next_nl - content_data) + 1 : content_size;
                    }

                    if (current_pos >= content_size) break;

                    size_t len = end_pos - current_pos;
                    const char* ptr = content_data + current_pos;

                    chunk_futures.push_back(std::async(std::launch::async,
                        [ptr, len, headers, &data, &processed_bytes, progress, total_uncompressed_size, current_feed_id, current_feed_id_int]() {
                            std::vector<StopTime> vec;
                            vec.reserve(len / 50);

                            auto chunk_progress = [&](size_t delta_bytes) {
                                int64_t current = processed_bytes.fetch_add(static_cast<int64_t>(delta_bytes)) + static_cast<int64_t>(delta_bytes);
                                if (progress) {
                                    if (current > total_uncompressed_size) current = total_uncompressed_size;
                                    progress("Loading GTFS Data (Feed " + current_feed_id + ")", current, total_uncompressed_size);
                                }
                            };

                            parse_stop_times_chunk(data.string_pool, ptr, len, headers, current_feed_id_int, vec, chunk_progress);
                            return vec;
                        }
                    ));
                    current_pos = end_pos;
                }

                std::unordered_map<uint32_t, std::vector<StopTime>> current_feed_stop_times;
                size_t total_count = 0;

                for (auto& f : chunk_futures) {
                    auto chunk_vec = f.get();
                    total_count += chunk_vec.size();
                    for (auto& st : chunk_vec) {
                        current_feed_stop_times[st.trip_id].push_back(std::move(st));
                    }
                }

                for (auto& [tid, vec] : current_feed_stop_times) {
                    if (merge_strategy == 1 && merged_stop_times.count(tid)) continue;
                    if (merge_strategy == 2 && merged_stop_times.count(tid)) {
                        throw std::runtime_error("Duplicate trip_id in stop_times: " + data.string_pool.get(tid));
                    }

                    std::sort(vec.begin(), vec.end(), [](const StopTime& a, const StopTime& b) {
                        return a.stop_sequence < b.stop_sequence;
                    });
                    merged_stop_times[tid] = std::move(vec);
                }

                if (log) log("Loaded " + std::to_string(total_count) + " entries from stop_times.txt");
                return total_count;
            });
        }

        for (auto& f : futures) {
            f.get();
        }
        if (stop_times_future.valid()) {
            stop_times_future.get();
        }

    } // end feed loop

    if (log) log("All feeds loaded. Finalizing data...");

    for (auto& [id, vec] : merged_shapes) {
        data.shapes.insert(data.shapes.end(), vec.begin(), vec.end());
    }

    size_t total_st = 0;
    for (const auto& [tid, vec] : merged_stop_times) {
        total_st += vec.size();
    }
    data.stop_times.reserve(total_st);

    for (auto& [tid, vec] : merged_stop_times) {
        data.stop_times.insert(data.stop_times.end(), vec.begin(), vec.end());
    }

    if (log) log("Sorting stop times...");
    std::sort(data.stop_times.begin(), data.stop_times.end(),
        [](const StopTime& a, const StopTime& b) {
            if (a.trip_id != b.trip_id) return a.trip_id < b.trip_id;
            return a.stop_sequence < b.stop_sequence;
        });

    if (log) log("Indexing stop times by stop_id...");
    for (size_t i = 0; i < data.stop_times.size(); ++i) {
        data.stop_times_by_stop_id[data.stop_times[i].stop_id].push_back(i);
    }

    // Build O(1) trip lookup index: key = (feed_id_intern << 32) | trip_id_intern
    if (log) log("Building trip intern index...");
    for (const auto& [fid_str, feed_map] : data.trips) {
        uint32_t fid_int = data.string_pool.get_id(fid_str);
        for (const auto& [tid_str, trip] : feed_map) {
            uint32_t tid_int = data.string_pool.get_id(tid_str);
            if (fid_int != 0xFFFFFFFF && tid_int != 0xFFFFFFFF) {
                uint64_t key = (static_cast<uint64_t>(fid_int) << 32) | tid_int;
                data.trip_by_intern_id[key] = &trip;
            }
        }
    }

    if (log) log("GTFS Data Loading Complete.");
}


} 
