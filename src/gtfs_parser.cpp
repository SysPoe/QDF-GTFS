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
#include <iterator>
#include <charconv>
#include <cmath>
#include <limits>

namespace gtfs {

using LogFn = std::function<void(const std::string&)>;
using ProgressFn = std::function<void(std::string task, int64_t current, int64_t total)>;


// Emit progress roughly every 64KB processed per file
constexpr size_t PROGRESS_CHUNK_BYTES = 64 * 1024;
constexpr size_t MAX_ZIP_ENTRIES = 512;
constexpr uint64_t MAX_ZIP_ENTRY_BYTES = 128ull * 1024 * 1024;
constexpr uint64_t MAX_ZIP_TOTAL_BYTES = 512ull * 1024 * 1024;
constexpr uint64_t MAX_ZIP_COMPRESSION_RATIO = 200;


// Helper to remove UTF-8 BOM if present
void remove_bom(std::string& line) {
    if ((line.size() >= 2 && static_cast<unsigned char>(line[0]) == 0xFF && static_cast<unsigned char>(line[1]) == 0xFE) ||
        (line.size() >= 2 && static_cast<unsigned char>(line[0]) == 0xFE && static_cast<unsigned char>(line[1]) == 0xFF) ||
        line.find('\0') != std::string::npos) {
        throw std::runtime_error("GTFS CSV must be UTF-8 text");
    }
    if (line.size() >= 3 && 
        static_cast<unsigned char>(line[0]) == 0xEF && 
        static_cast<unsigned char>(line[1]) == 0xBB && 
        static_cast<unsigned char>(line[2]) == 0xBF) {
        line.erase(0, 3);
    }
}


// Helper to convert "HH:MM:SS" to seconds
int parse_time_seconds_view(const char* data, size_t len);

int parse_time_seconds(const std::string& time_str) {
    if (time_str.empty()) return -1;
    return parse_time_seconds_view(time_str.data(), time_str.size());
}

int parse_time_seconds_view(const char* data, size_t len) {
    if (!data || len == 0) return -1;
    const char* ptr = data;
    const char* end = data + len;

    while (ptr < end && *ptr == ' ') ptr++;

    int64_t h = 0, m = 0, s = 0;

    auto append_digit = [](int64_t& value, char digit) {
        if (value > (std::numeric_limits<int64_t>::max() - 9) / 10) {
            throw std::runtime_error("GTFS time field is out of range");
        }
        value = value * 10 + (digit - '0');
    };

    if (ptr >= end || *ptr < '0' || *ptr > '9') throw std::runtime_error("Invalid GTFS time field");
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        append_digit(h, *ptr);
        ptr++;
    }
    if (ptr >= end || *ptr != ':') throw std::runtime_error("Invalid GTFS time field");
    ptr++;

    if (ptr >= end || *ptr < '0' || *ptr > '9') throw std::runtime_error("Invalid GTFS time field");
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        append_digit(m, *ptr);
        ptr++;
    }
    if (ptr >= end || *ptr != ':') throw std::runtime_error("Invalid GTFS time field");
    ptr++;

    if (ptr >= end || *ptr < '0' || *ptr > '9') throw std::runtime_error("Invalid GTFS time field");
    while (ptr < end && *ptr >= '0' && *ptr <= '9') {
        append_digit(s, *ptr);
        ptr++;
    }

    while (ptr < end && *ptr == ' ') ++ptr;
    if (ptr != end || m > 59 || s > 59 || h > (std::numeric_limits<int32_t>::max() - 3599) / 3600) {
        throw std::runtime_error("Invalid GTFS time field");
    }
    return static_cast<int>(h * 3600 + m * 60 + s);
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

    if (ptr == end) return default_val;
    int64_t magnitude = 0;
    const char* digits = ptr;
    const auto parsed = std::from_chars(ptr, end, magnitude);
    if (parsed.ec != std::errc() || parsed.ptr == digits) {
        throw std::runtime_error("Invalid GTFS integer field");
    }
    ptr = parsed.ptr;
    while (ptr < end && *ptr == ' ') ++ptr;
    const int64_t signed_value = magnitude * sign;
    if (ptr != end || signed_value < std::numeric_limits<int>::min() || signed_value > std::numeric_limits<int>::max()) {
        throw std::runtime_error("GTFS integer field is out of range");
    }
    return static_cast<int>(signed_value);
}

bool parse_double_view(const char* data, size_t len, double& out) {
    if (!data || len == 0) return false;
    std::string buf(data, len);
    char* endp = nullptr;
    errno = 0;
    out = std::strtod(buf.c_str(), &endp);
    while (endp && *endp == ' ') ++endp;
    if (endp == buf.c_str() || !endp || *endp != '\0' || errno == ERANGE || !std::isfinite(out)) {
        throw std::runtime_error("Invalid GTFS floating-point field");
    }
    return true;
}


// Advance past the next newline; sets line_start/line_len (without \r\n)
static inline const char* advance_line(const char* ptr, const char* end, const char*& line_start, size_t& line_len) {
    line_start = ptr;
    bool inside_quotes = false;
    for (const char* current = ptr; current < end; ++current) {
        if (*current == '"') {
            if (inside_quotes && current + 1 < end && current[1] == '"') {
                ++current;
            } else {
                inside_quotes = !inside_quotes;
            }
        } else if (!inside_quotes && (*current == '\n' || *current == '\r')) {
            line_len = static_cast<size_t>(current - ptr);
            if (*current == '\r' && current + 1 < end && current[1] == '\n') ++current;
            return current + 1;
        }
    }
    if (inside_quotes) throw std::runtime_error("Unbalanced quote in GTFS CSV record");
    line_len = static_cast<size_t>(end - ptr);
    return end;
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
    if (inside_quotes) throw std::runtime_error("Unbalanced quote in GTFS CSV record");
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

void require_columns(const std::vector<std::string>& headers, std::initializer_list<const char*> required, const char* filename) {
    for (const char* column : required) {
        if (get_col_index(headers, column) < 0) {
            throw std::runtime_error(std::string(filename) + " is missing required column " + column);
        }
    }
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

int get_bounded_int(const std::vector<std::string>& row, int index, int default_val, int minimum, int maximum, const char* field) {
    const int value = get_int(row, index, default_val);
    if (value < minimum || value > maximum) {
        throw std::runtime_error(std::string(field) + " is out of range");
    }
    return value;
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
    const int parsed = parse_int_view(val.data(), val.size());
    if (parsed != 0 && parsed != 1) throw std::runtime_error("GTFS boolean field must be 0 or 1");
    return parsed == 1;
}

bool valid_gtfs_date(const std::string& value) {
    if (value.size() != 8 || !std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= '0' && c <= '9'; })) return false;
    const int year = parse_int_view(value.data(), 4);
    const int month = parse_int_view(value.data() + 4, 2);
    const int day = parse_int_view(value.data() + 6, 2);
    if (month < 1 || month > 12 || day < 1) return false;
    static constexpr int daysPerMonth[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    int maximum = daysPerMonth[month - 1];
    if (month == 2 && (year % 400 == 0 || (year % 4 == 0 && year % 100 != 0))) maximum = 29;
    return day <= maximum;
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
    require_columns(headers, {"agency_name", "agency_url", "agency_timezone"}, "agency.txt");
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
        if (a.agency_name.empty()) throw std::runtime_error("agency.txt contains an empty agency_name");
        a.agency_url = get_val(row, url_idx);
        if (a.agency_url.empty()) throw std::runtime_error("agency.txt contains an empty agency_url");
        a.agency_timezone = get_val(row, tz_idx);
        if (a.agency_timezone.empty()) throw std::runtime_error("agency.txt contains an empty agency_timezone");
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
    require_columns(headers, {"route_id", "route_type"}, "routes.txt");
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
        if (r.route_id.empty()) throw std::runtime_error("routes.txt contains an empty route_id");
        tmp = get_val(row, agency_id_idx);
        if (!tmp.empty()) r.agency_id = tmp;
        tmp = get_val(row, short_name_idx);
        if (!tmp.empty()) r.route_short_name = tmp;
        tmp = get_val(row, long_name_idx);
        if (!tmp.empty()) r.route_long_name = tmp;
        tmp = get_val(row, desc_idx);
        if (!tmp.empty()) r.route_desc = tmp;
        tmp = get_val(row, type_idx);
        if (tmp.empty()) throw std::runtime_error("routes.txt contains an empty route_type");
        // route_type allows GTFS extended values (e.g. 100+), so only bound to non-negative.
        r.route_type = get_bounded_int(row, type_idx, 0, 0, std::numeric_limits<int>::max(), "route_type");
        tmp = get_val(row, url_idx);
        if (!tmp.empty()) r.route_url = tmp;
        tmp = get_val(row, color_idx);
        if (!tmp.empty()) r.route_color = tmp;
        tmp = get_val(row, text_color_idx);
        if (!tmp.empty()) r.route_text_color = tmp;
        tmp = get_val(row, cont_pickup_idx);
        if (!tmp.empty()) r.continuous_pickup = get_bounded_int(row, cont_pickup_idx, 0, 0, 3, "continuous_pickup");
        tmp = get_val(row, cont_drop_off_idx);
        if (!tmp.empty()) r.continuous_drop_off = get_bounded_int(row, cont_drop_off_idx, 0, 0, 3, "continuous_drop_off");
        tmp = get_val(row, sort_order_idx);
        if (!tmp.empty()) r.route_sort_order = get_bounded_int(row, sort_order_idx, 0, 0, std::numeric_limits<int>::max(), "route_sort_order");
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
    require_columns(headers, {"route_id", "service_id", "trip_id"}, "trips.txt");
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

    const uint32_t feed_id_int = data.string_pool.intern(feed_id);
    auto& feed_trips = data.trips[feed_id_int];
    feed_trips.reserve(content_size / 80 + 16);

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Trip t;
        t.feed_id = feed_id_int;
        std::string tmp;
        const std::string route_id = get_val(row, route_id_idx);
        const std::string service_id = get_val(row, service_id_idx);
        const std::string trip_id = get_val(row, trip_id_idx);
        if (route_id.empty() || service_id.empty() || trip_id.empty()) throw std::runtime_error("trips.txt contains an empty required ID");
        t.route_id = data.string_pool.intern(route_id);
        t.service_id = data.string_pool.intern(service_id);
        t.trip_id = data.string_pool.intern(trip_id);
        tmp = get_val(row, headsign_idx);
        if (!tmp.empty()) t.trip_headsign = data.string_pool.intern(tmp);
        tmp = get_val(row, short_name_idx);
        if (!tmp.empty()) t.trip_short_name = data.string_pool.intern(tmp);
        tmp = get_val(row, direction_id_idx);
        if (!tmp.empty()) t.direction_id = static_cast<int32_t>(get_bounded_int(row, direction_id_idx, 0, 0, 1, "direction_id"));
        tmp = get_val(row, block_id_idx);
        if (!tmp.empty()) t.block_id = data.string_pool.intern(tmp);
        tmp = get_val(row, shape_id_idx);
        if (!tmp.empty()) t.shape_id = data.string_pool.intern(tmp);
        tmp = get_val(row, wheelchair_idx);
        if (!tmp.empty()) t.wheelchair_accessible = static_cast<int32_t>(get_bounded_int(row, wheelchair_idx, 0, 0, 2, "wheelchair_accessible"));
        tmp = get_val(row, bikes_idx);
        if (!tmp.empty()) t.bikes_allowed = static_cast<int32_t>(get_bounded_int(row, bikes_idx, 0, 0, 2, "bikes_allowed"));

        if (merge_strategy == 1 && feed_trips.count(t.trip_id)) continue;
        if (merge_strategy == 2 && feed_trips.count(t.trip_id)) {
            throw std::runtime_error("Duplicate trip: " + data.string_pool.get(t.trip_id));
        }

        feed_trips[t.trip_id] = t;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_transfers(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);

    auto headers = parse_csv_line(header_str);
    require_columns(headers, {"from_stop_id", "to_stop_id", "transfer_type"}, "transfers.txt");
    int from_stop_idx = get_col_index(headers, "from_stop_id");
    int to_stop_idx = get_col_index(headers, "to_stop_id");
    int from_route_idx = get_col_index(headers, "from_route_id");
    int to_route_idx = get_col_index(headers, "to_route_id");
    int from_trip_idx = get_col_index(headers, "from_trip_id");
    int to_trip_idx = get_col_index(headers, "to_trip_id");
    int type_idx = get_col_index(headers, "transfer_type");
    int min_time_idx = get_col_index(headers, "min_transfer_time");

    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    // Per-feed dedup preserves feed qualification: the logical key is the
    // feed-qualified from/to tuple plus transfer_type; min_transfer_time is
    // the mutable value (IGNORE keeps first, OVERWRITE keeps last).
    auto transfer_key = [](const std::string& feed, const Transfer& t) {
        std::string k;
        k.reserve(feed.size() + 64);
        k += feed; k.push_back('\x1f');
        if (t.from_stop_id) { k += *t.from_stop_id; } k.push_back('\x1f');
        if (t.to_stop_id) { k += *t.to_stop_id; } k.push_back('\x1f');
        if (t.from_route_id) { k += *t.from_route_id; } k.push_back('\x1f');
        if (t.to_route_id) { k += *t.to_route_id; } k.push_back('\x1f');
        if (t.from_trip_id) { k += *t.from_trip_id; } k.push_back('\x1f');
        if (t.to_trip_id) { k += *t.to_trip_id; } k.push_back('\x1f');
        k += std::to_string(t.transfer_type);
        return k;
    };
    std::unordered_map<std::string, size_t> seen;
    for (size_t i = 0; i < data.transfers.size(); ++i) {
        if (data.transfers[i].feed_id != feed_id) continue;
        seen.emplace(transfer_key(feed_id, data.transfers[i]), i);
    }
    data.transfers.reserve(data.transfers.size() + content_size / 100 + 16);
    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        Transfer transfer;
        transfer.feed_id = feed_id;
        std::string tmp;

        tmp = get_val(row, from_stop_idx);
        if (!tmp.empty()) transfer.from_stop_id = tmp;
        tmp = get_val(row, to_stop_idx);
        if (!tmp.empty()) transfer.to_stop_id = tmp;
        tmp = get_val(row, from_route_idx);
        if (!tmp.empty()) transfer.from_route_id = tmp;
        tmp = get_val(row, to_route_idx);
        if (!tmp.empty()) transfer.to_route_id = tmp;
        tmp = get_val(row, from_trip_idx);
        if (!tmp.empty()) transfer.from_trip_id = tmp;
        tmp = get_val(row, to_trip_idx);
        if (!tmp.empty()) transfer.to_trip_id = tmp;
        tmp = get_val(row, type_idx);
        if (tmp.empty()) throw std::runtime_error("transfers.txt contains an empty transfer_type");
        transfer.transfer_type = get_bounded_int(row, type_idx, 0, 0, 5, "transfer_type");
        tmp = get_val(row, min_time_idx);
        if (!tmp.empty()) transfer.min_transfer_time = get_bounded_int(row, min_time_idx, 0, 0, std::numeric_limits<int>::max(), "min_transfer_time");

        const std::string key = transfer_key(feed_id, transfer);
        auto it = seen.find(key);
        if (it != seen.end()) {
            if (merge_strategy == 1) { report_progress(bytes_read); continue; }
            if (merge_strategy == 2) throw std::runtime_error("Duplicate transfer: " + feed_id);
            data.transfers[it->second] = transfer;
            count++;
            report_progress(bytes_read);
            continue;
        }
        seen.emplace(key, data.transfers.size());
        data.transfers.push_back(std::move(transfer));
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_frequencies(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start;
    size_t line_len;
    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header(line_start, line_len);
    remove_bom(header);
    const auto headers = parse_csv_line(header);
    require_columns(headers, {"trip_id", "start_time", "end_time", "headway_secs"}, "frequencies.txt");
    const int trip_idx = get_col_index(headers, "trip_id");
    const int start_idx = get_col_index(headers, "start_time");
    const int end_idx = get_col_index(headers, "end_time");
    const int headway_idx = get_col_index(headers, "headway_secs");
    const int exact_idx = get_col_index(headers, "exact_times");
    // Per-feed dedup preserves feed qualification: (feed, trip_id, start_time)
    // is the logical key; end/headway/exact are values.
    std::unordered_map<std::string, size_t> seen;
    for (size_t i = 0; i < data.frequencies.size(); ++i) {
        const auto& f = data.frequencies[i];
        if (f.feed_id != feed_id) continue;
        seen.emplace(feed_id + '\x1f' + f.trip_id + '\x1f' + std::to_string(f.start_time), i);
    }
    size_t count = 0;
    size_t bytes_read = static_cast<size_t>(ptr - content_data);
    while (ptr < end) {
        const char* next = advance_line(ptr, end, line_start, line_len);
        bytes_read += static_cast<size_t>(next - ptr);
        ptr = next;
        if (line_len == 0) continue;
        const auto row = parse_csv_line(std::string(line_start, line_len));
        Frequency frequency;
        frequency.feed_id = feed_id;
        frequency.trip_id = get_val(row, trip_idx);
        if (frequency.trip_id.empty()) throw std::runtime_error("frequencies.txt contains an empty trip_id");
        frequency.start_time = parse_time_seconds(get_val(row, start_idx));
        frequency.end_time = parse_time_seconds(get_val(row, end_idx));
        frequency.headway_secs = get_int(row, headway_idx);
        frequency.exact_times = static_cast<int8_t>(get_bounded_int(row, exact_idx, 0, 0, 1, "exact_times"));
        if (frequency.start_time < 0 || frequency.end_time <= frequency.start_time || frequency.headway_secs <= 0) {
            throw std::runtime_error("frequencies.txt contains an invalid time range or headway");
        }
        const std::string key = feed_id + '\x1f' + frequency.trip_id + '\x1f' + std::to_string(frequency.start_time);
        auto it = seen.find(key);
        if (it != seen.end()) {
            if (merge_strategy == 1) continue;
            if (merge_strategy == 2) throw std::runtime_error("Duplicate frequency: " + feed_id + "/" + frequency.trip_id);
            data.frequencies[it->second] = frequency;
            ++count;
            if (on_progress) on_progress(bytes_read);
            continue;
        }
        seen.emplace(key, data.frequencies.size());
        data.frequencies.push_back(std::move(frequency));
        ++count;
        if (on_progress) on_progress(bytes_read);
    }
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
    require_columns(headers, {"stop_id", "stop_name"}, "stops.txt");
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
    int tts_idx = get_col_index(headers, "tts_stop_name");

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
        if (s.stop_id.empty()) throw std::runtime_error("stops.txt contains an empty stop_id");
        tmp = get_val(row, code_idx);
        if (!tmp.empty()) s.stop_code = tmp;
        s.stop_name = get_val(row, name_idx);
        if (s.stop_name.empty()) throw std::runtime_error("stops.txt contains an empty stop_name");
        tmp = get_val(row, desc_idx);
        if (!tmp.empty()) s.stop_desc = tmp;
        tmp = get_val(row, lat_idx);
        if (!tmp.empty()) s.stop_lat = get_double(row, lat_idx);
        tmp = get_val(row, lon_idx);
        if (!tmp.empty()) s.stop_lon = get_double(row, lon_idx);
        if ((s.stop_lat.has_value() && (*s.stop_lat < -90 || *s.stop_lat > 90)) ||
            (s.stop_lon.has_value() && (*s.stop_lon < -180 || *s.stop_lon > 180))) {
            throw std::runtime_error("stops.txt contains an out-of-range coordinate");
        }
        tmp = get_val(row, zone_idx);
        if (!tmp.empty()) s.zone_id = tmp;
        tmp = get_val(row, url_idx);
        if (!tmp.empty()) s.stop_url = tmp;
        tmp = get_val(row, loc_type_idx);
        if (!tmp.empty()) s.location_type = get_bounded_int(row, loc_type_idx, 0, 0, 4, "location_type");
        tmp = get_val(row, parent_idx);
        if (!tmp.empty()) s.parent_station = tmp;
        tmp = get_val(row, tz_idx);
        if (!tmp.empty()) s.stop_timezone = tmp;
        tmp = get_val(row, wheelchair_idx);
        if (!tmp.empty()) s.wheelchair_boarding = get_bounded_int(row, wheelchair_idx, 0, 0, 2, "wheelchair_boarding");
        tmp = get_val(row, level_idx);
        if (!tmp.empty()) s.level_id = tmp;
        tmp = get_val(row, platform_idx);
        if (!tmp.empty()) s.platform_code = tmp;
        tmp = get_val(row, tts_idx);
        if (!tmp.empty()) s.tts_stop_name = tmp;

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
    require_columns(headers, {"trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"}, "stop_times.txt");
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
        const char* line_start;
        size_t raw_len;
        const char* next = advance_line(ptr, end, line_start, raw_len);
        bytes_read += static_cast<size_t>(next - ptr);
        ptr = next;
        if (raw_len == 0) {
            report_progress(bytes_read);
            continue;
        }

        size_t parse_len = raw_len;
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
            const std::string trip_id = get_val(row_str, trip_id_idx);
            const std::string stop_id = get_val(row_str, stop_id_idx);
            if (trip_id.empty() || stop_id.empty()) throw std::runtime_error("stop_times.txt contains an empty required ID");
            st.trip_id = string_pool.intern(trip_id);
            {
                int t = parse_time_seconds(get_val(row_str, arrival_idx));
                st.arrival_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
            }
            {
                int t = parse_time_seconds(get_val(row_str, departure_idx));
                st.departure_time = (t != -1) ? static_cast<int32_t>(t) : ST_NO_TIME;
            }
            st.stop_id = string_pool.intern(stop_id);
            if (get_val(row_str, seq_idx).empty()) throw std::runtime_error("stop_times.txt contains an empty stop_sequence");
            st.stop_sequence = get_bounded_int(row_str, seq_idx, 0, 0, std::numeric_limits<int>::max(), "stop_sequence");
            {
                const std::string& hs = get_val(row_str, headsign_idx);
                st.stop_headsign = hs.empty() ? ST_NO_HEADSIGN : string_pool.intern(hs);
            }
            st.pickup_type   = static_cast<int8_t>(get_bounded_int(row_str, pickup_idx, 0, 0, 3, "pickup_type"));
            st.drop_off_type = static_cast<int8_t>(get_bounded_int(row_str, drop_off_idx, 0, 0, 3, "drop_off_type"));
            {
                const std::string& dv = get_val(row_str, dist_idx);
                if (!dv.empty()) {
                    double d = 0.0;
                    st.shape_dist_traveled = parse_double_view(dv.data(), dv.size(), d) ? d : ST_NO_DIST;
                }
            }
            {
                const std::string& tv = get_val(row_str, timepoint_idx);
                st.timepoint = tv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_bounded_int(row_str, timepoint_idx, 0, 0, 1, "timepoint"));
            }
            {
                const std::string& cpv = get_val(row_str, cont_pickup_idx);
                st.continuous_pickup = cpv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_bounded_int(row_str, cont_pickup_idx, 0, 0, 3, "continuous_pickup"));
            }
            {
                const std::string& cdv = get_val(row_str, cont_drop_off_idx);
                st.continuous_drop_off = cdv.empty() ? ST_NO_INT8 : static_cast<int8_t>(get_bounded_int(row_str, cont_drop_off_idx, 0, 0, 3, "continuous_drop_off"));
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
        if (!trip_view.first || trip_view.second == 0) throw std::runtime_error("stop_times.txt contains an empty trip_id");
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
        if (!stop_view.first || stop_view.second == 0) throw std::runtime_error("stop_times.txt contains an empty stop_id");
        st.stop_id = string_pool.intern(stop_view.first, stop_view.second);

        auto seq_view = get_view(seq_idx);
        if (!seq_view.first || seq_view.second == 0) throw std::runtime_error("stop_times.txt contains an empty stop_sequence");
        st.stop_sequence = parse_int_view(seq_view.first, seq_view.second);
        if (st.stop_sequence < 0) throw std::runtime_error("stop_sequence is out of range");

        auto headsign_view = get_view(headsign_idx);
        st.stop_headsign = (headsign_view.first && headsign_view.second > 0)
            ? string_pool.intern(headsign_view.first, headsign_view.second)
            : ST_NO_HEADSIGN;

        auto pickup_view = get_view(pickup_idx);
        const int pickup_type = parse_int_view(pickup_view.first, pickup_view.second);
        if (pickup_type < 0 || pickup_type > 3) throw std::runtime_error("pickup_type is out of range");
        st.pickup_type = static_cast<int8_t>(pickup_type);
        auto drop_view = get_view(drop_off_idx);
        const int drop_off_type = parse_int_view(drop_view.first, drop_view.second);
        if (drop_off_type < 0 || drop_off_type > 3) throw std::runtime_error("drop_off_type is out of range");
        st.drop_off_type = static_cast<int8_t>(drop_off_type);

        auto dist_view = get_view(dist_idx);
        if (dist_view.first && dist_view.second > 0) {
            double dist_val = 0.0;
            st.shape_dist_traveled = parse_double_view(dist_view.first, dist_view.second, dist_val) ? dist_val : ST_NO_DIST;
        }

        auto timepoint_view = get_view(timepoint_idx);
        if (timepoint_view.first && timepoint_view.second > 0) {
            const int value = parse_int_view(timepoint_view.first, timepoint_view.second);
            if (value < 0 || value > 1) throw std::runtime_error("timepoint is out of range");
            st.timepoint = static_cast<int8_t>(value);
        }

        auto cont_pickup_view = get_view(cont_pickup_idx);
        if (cont_pickup_view.first && cont_pickup_view.second > 0) {
            const int value = parse_int_view(cont_pickup_view.first, cont_pickup_view.second);
            if (value < 0 || value > 3) throw std::runtime_error("continuous_pickup is out of range");
            st.continuous_pickup = static_cast<int8_t>(value);
        }

        auto cont_drop_view = get_view(cont_drop_off_idx);
        if (cont_drop_view.first && cont_drop_view.second > 0) {
            const int value = parse_int_view(cont_drop_view.first, cont_drop_view.second);
            if (value < 0 || value > 3) throw std::runtime_error("continuous_drop_off is out of range");
            st.continuous_drop_off = static_cast<int8_t>(value);
        }

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
    require_columns(headers, {"service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"}, "calendar.txt");
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
        if (c.service_id.empty()) throw std::runtime_error("calendar.txt contains an empty service_id");
        for (const auto& item : std::initializer_list<std::pair<int, const char*>>{
            {mon_idx, "monday"}, {tue_idx, "tuesday"}, {wed_idx, "wednesday"},
            {thu_idx, "thursday"}, {fri_idx, "friday"}, {sat_idx, "saturday"}, {sun_idx, "sunday"}}) {
            if (get_val(row, item.first).empty()) throw std::runtime_error(std::string("calendar.txt contains an empty ") + item.second);
        }
        c.monday = get_bool(row, mon_idx);
        c.tuesday = get_bool(row, tue_idx);
        c.wednesday = get_bool(row, wed_idx);
        c.thursday = get_bool(row, thu_idx);
        c.friday = get_bool(row, fri_idx);
        c.saturday = get_bool(row, sat_idx);
        c.sunday = get_bool(row, sun_idx);
        c.start_date = get_val(row, start_idx);
        c.end_date = get_val(row, end_idx2);
        if (!valid_gtfs_date(c.start_date) || !valid_gtfs_date(c.end_date) || c.start_date > c.end_date) {
            throw std::runtime_error("calendar.txt contains an invalid date range");
        }

        if (merge_strategy == 1 && data.calendars[feed_id].count(c.service_id)) continue;
        if (merge_strategy == 2 && data.calendars[feed_id].count(c.service_id)) throw std::runtime_error("Duplicate calendar: " + c.service_id);

        data.calendars[feed_id][c.service_id] = c;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_occupancies(GTFSData& data, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
    const char* ptr = content_data;
    const char* end = content_data + content_size;
    const char* line_start; size_t line_len;

    ptr = advance_line(ptr, end, line_start, line_len);
    if (line_len == 0) return 0;
    std::string header_str(line_start, line_len);
    remove_bom(header_str);
    auto headers = parse_csv_line(header_str);
    require_columns(headers, {"trip_id", "stop_sequence", "occupancy_status", "start_date"}, "occupancies.txt");

    const int trip_idx = get_col_index(headers, "trip_id");
    const int sequence_idx = get_col_index(headers, "stop_sequence");
    const int status_idx = get_col_index(headers, "occupancy_status");
    const int monday_idx = get_col_index(headers, "monday");
    const int tuesday_idx = get_col_index(headers, "tuesday");
    const int wednesday_idx = get_col_index(headers, "wednesday");
    const int thursday_idx = get_col_index(headers, "thursday");
    const int friday_idx = get_col_index(headers, "friday");
    const int saturday_idx = get_col_index(headers, "saturday");
    const int sunday_idx = get_col_index(headers, "sunday");
    const int start_idx = get_col_index(headers, "start_date");
    const int end_idx = get_col_index(headers, "end_date");
    const int exception_idx = get_col_index(headers, "exception");

    const uint32_t feed_id_int = data.string_pool.intern(feed_id);
    // Per-feed dedup preserves feed qualification: identical rows within one
    // feed collapse (IGNORE keeps first, OVERWRITE keeps last, THROW fails).
    std::unordered_map<std::string, size_t> seen;
    for (size_t i = 0; i < data.static_occupancies.size(); ++i) {
        const auto& o = data.static_occupancies[i];
        if (o.feed_id != feed_id_int) continue;
        std::string k = std::to_string(o.trip_id) + '\x1f' + std::to_string(o.stop_sequence) + '\x1f' +
            std::to_string(static_cast<int>(o.occupancy_status)) + '\x1f' + std::to_string(o.start_date) + '\x1f' +
            std::to_string(o.end_date) + '\x1f' + std::to_string(static_cast<int>(o.exception)) + '\x1f' +
            std::to_string(static_cast<int>(o.weekday_mask));
        seen.emplace(std::move(k), i);
    }
    size_t count = 0;
    size_t bytes_read = line_len + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };

    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        auto row = parse_csv_line(std::string(line_start, line_len));
        const std::string trip_id = get_val(row, trip_idx);
        if (trip_id.empty()) throw std::runtime_error("occupancies.txt contains an empty trip_id");
        const std::string status_s = get_val(row, status_idx);
        if (status_s.empty()) throw std::runtime_error("occupancies.txt contains an empty occupancy_status");
        const int status = get_bounded_int(row, status_idx, 0, 0, 6, "occupancy_status");
        if (get_val(row, sequence_idx).empty()) throw std::runtime_error("occupancies.txt contains an empty stop_sequence");

        StaticOccupancy occupancy;
        occupancy.trip_id = data.string_pool.intern(trip_id);
        occupancy.feed_id = feed_id_int;
        occupancy.stop_sequence = get_bounded_int(row, sequence_idx, 0, 0, std::numeric_limits<int>::max(), "stop_sequence");
        occupancy.occupancy_status = static_cast<int8_t>(status);
        const std::string start_date = get_val(row, start_idx);
        const std::string end_date = get_val(row, end_idx);
        if (!valid_gtfs_date(start_date) || (!end_date.empty() && !valid_gtfs_date(end_date)) ||
            (!end_date.empty() && start_date > end_date)) throw std::runtime_error("occupancies.txt contains an invalid date range");
        occupancy.start_date = static_cast<uint32_t>(parse_int_view(start_date.data(), start_date.size()));
        occupancy.end_date = end_date.empty() ? 0 : static_cast<uint32_t>(parse_int_view(end_date.data(), end_date.size()));
        occupancy.exception = static_cast<int8_t>(get_bounded_int(row, exception_idx, 0, 0, 1, "exception"));
        occupancy.weekday_mask =
            (get_bool(row, monday_idx) ? 1u << 0 : 0) |
            (get_bool(row, tuesday_idx) ? 1u << 1 : 0) |
            (get_bool(row, wednesday_idx) ? 1u << 2 : 0) |
            (get_bool(row, thursday_idx) ? 1u << 3 : 0) |
            (get_bool(row, friday_idx) ? 1u << 4 : 0) |
            (get_bool(row, saturday_idx) ? 1u << 5 : 0) |
            (get_bool(row, sunday_idx) ? 1u << 6 : 0);
        const std::string key = std::to_string(occupancy.trip_id) + '\x1f' + std::to_string(occupancy.stop_sequence) + '\x1f' +
            std::to_string(status) + '\x1f' + std::to_string(occupancy.start_date) + '\x1f' +
            std::to_string(occupancy.end_date) + '\x1f' + std::to_string(static_cast<int>(occupancy.exception)) + '\x1f' +
            std::to_string(static_cast<int>(occupancy.weekday_mask));
        auto seen_it = seen.find(key);
        if (seen_it != seen.end()) {
            if (merge_strategy == 1) { report_progress(bytes_read); continue; }
            if (merge_strategy == 2) throw std::runtime_error("Duplicate occupancy: " + trip_id + "/" + get_val(row, sequence_idx));
            data.static_occupancies[seen_it->second] = occupancy;
            count++;
            report_progress(bytes_read);
            continue;
        }
        seen.emplace(key, data.static_occupancies.size());
        data.static_occupancies.push_back(occupancy);
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
    require_columns(headers, {"service_id", "date", "exception_type"}, "calendar_dates.txt");
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
        if (service_id.empty() || !valid_gtfs_date(date) || (exc != 1 && exc != 2)) throw std::runtime_error("calendar_dates.txt contains an invalid row");

        auto& dates = data.calendar_dates[feed_id][service_id];
        if (dates.count(date)) {
            if (merge_strategy == 1) continue;
            if (merge_strategy == 2) throw std::runtime_error("Duplicate calendar date: " + feed_id + "/" + service_id + "/" + date);
        }
        dates[date] = exc;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_shapes(GTFSData& data, std::unordered_map<uint64_t, std::vector<Shape>>& merged_shapes, const char* content_data, size_t content_size, int merge_strategy, const std::string& feed_id, const std::function<void(size_t)>& on_progress = nullptr) {
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
    require_columns(headers, {"shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"}, "shapes.txt");
    int id_idx = get_col_index(headers, "shape_id");
    int lat_idx = get_col_index(headers, "shape_pt_lat");
    int lon_idx = get_col_index(headers, "shape_pt_lon");
    int seq_idx = get_col_index(headers, "shape_pt_sequence");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");
    const uint32_t feed_id_int = data.string_pool.intern(feed_id);

    std::unordered_map<std::string, std::vector<Shape>> feed_shapes;

    size_t count = 0;
    while (ptr < end) {
        ptr = advance_line(ptr, end, line_start, line_len);
        bytes_read += line_len + 1;
        if (line_len == 0) { report_progress(bytes_read); continue; }
        std::string line(line_start, line_len);
        auto row = parse_csv_line(line);
        std::string shape_id = get_val(row, id_idx);
        if (shape_id.empty()) throw std::runtime_error("shapes.txt contains an empty shape_id");
        auto [shape_it, inserted] = feed_shapes.try_emplace(shape_id);

        Shape s;
        s.feed_id = feed_id_int;
        s.shape_id = inserted
            ? data.string_pool.intern(shape_it->first)
            : shape_it->second.front().shape_id;
        const std::string lat_s = get_val(row, lat_idx);
        const std::string lon_s = get_val(row, lon_idx);
        const std::string seq_s = get_val(row, seq_idx);
        if (lat_s.empty() || lon_s.empty()) throw std::runtime_error("shapes.txt contains an empty shape_pt_lat/shape_pt_lon");
        if (seq_s.empty()) throw std::runtime_error("shapes.txt contains an empty shape_pt_sequence");
        s.shape_pt_lat = get_double(row, lat_idx);
        s.shape_pt_lon = get_double(row, lon_idx);
        if (!std::isfinite(s.shape_pt_lat) || !std::isfinite(s.shape_pt_lon)) {
            throw std::runtime_error("shapes.txt contains a non-finite coordinate");
        }
        if (s.shape_pt_lat < -90 || s.shape_pt_lat > 90 || s.shape_pt_lon < -180 || s.shape_pt_lon > 180) {
            throw std::runtime_error("shapes.txt contains an out-of-range coordinate");
        }
        s.shape_pt_sequence = get_bounded_int(row, seq_idx, 0, 0, std::numeric_limits<int>::max(), "shape_pt_sequence");
        std::string tmp = get_val(row, dist_idx);
        if (!tmp.empty()) s.shape_dist_traveled = get_double(row, dist_idx);

        shape_it->second.push_back(s);
        count++;
        report_progress(bytes_read);
    }

    for (auto& [id, vec] : feed_shapes) {
        const uint32_t shape_id_int = vec.empty() ? data.string_pool.intern(id) : vec.front().shape_id;
        const uint64_t qualified_id = (static_cast<uint64_t>(feed_id_int) << 32) | shape_id_int;
        if (merge_strategy == 1 && merged_shapes.count(qualified_id)) continue;
        if (merge_strategy == 2 && merged_shapes.count(qualified_id)) throw std::runtime_error("Duplicate shape: " + feed_id + "/" + id);

        std::sort(vec.begin(), vec.end(), [](const Shape& a, const Shape& b){
            return a.shape_pt_sequence < b.shape_pt_sequence;
        });

        merged_shapes[qualified_id] = std::move(vec);
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
    require_columns(headers, {"feed_publisher_name", "feed_publisher_url", "feed_lang"}, "feed_info.txt");
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
    // Per-feed singleton: feed_info has one logical row per feed. A second
    // row for the same feed is a duplicate (IGNORE keeps first, OVERWRITE
    // keeps last, THROW fails), preserving feed qualification across feeds.
    ssize_t existing_for_feed = -1;
    for (size_t i = 0; i < data.feed_info.size(); ++i) {
        if (data.feed_info[i].feed_id == feed_id) { existing_for_feed = static_cast<ssize_t>(i); break; }
    }
    bool seen_in_file = (existing_for_feed >= 0);
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
        if (f.feed_publisher_name.empty()) throw std::runtime_error("feed_info.txt contains an empty feed_publisher_name");
        f.feed_publisher_url = get_val(row, pub_url_idx);
        if (f.feed_publisher_url.empty()) throw std::runtime_error("feed_info.txt contains an empty feed_publisher_url");
        f.feed_lang = get_val(row, lang_idx);
        if (f.feed_lang.empty()) throw std::runtime_error("feed_info.txt contains an empty feed_lang");
        tmp = get_val(row, def_lang_idx);
        if (!tmp.empty()) f.default_lang = tmp;
        tmp = get_val(row, start_idx);
        if (!tmp.empty()) {
            if (!valid_gtfs_date(tmp)) throw std::runtime_error("feed_info.txt contains an invalid feed_start_date");
            f.feed_start_date = tmp;
        }
        tmp = get_val(row, end_idx2);
        if (!tmp.empty()) {
            if (!valid_gtfs_date(tmp)) throw std::runtime_error("feed_info.txt contains an invalid feed_end_date");
            f.feed_end_date = tmp;
        }
        if (f.feed_start_date.has_value() && f.feed_end_date.has_value() &&
            *f.feed_start_date > *f.feed_end_date) {
            throw std::runtime_error("feed_info.txt contains a feed_start_date after feed_end_date");
        }
        tmp = get_val(row, ver_idx);
        if (!tmp.empty()) f.feed_version = tmp;
        tmp = get_val(row, email_idx);
        if (!tmp.empty()) f.feed_contact_email = tmp;
        tmp = get_val(row, contact_url_idx);
        if (!tmp.empty()) f.feed_contact_url = tmp;

        if (seen_in_file) {
            if (merge_strategy == 1) { report_progress(bytes_read); continue; }
            if (merge_strategy == 2) throw std::runtime_error("Duplicate feed_info: " + feed_id);
            if (existing_for_feed >= 0) data.feed_info[static_cast<size_t>(existing_for_feed)] = f;
            else { existing_for_feed = static_cast<ssize_t>(data.feed_info.size()); data.feed_info.push_back(f); }
            count++;
            report_progress(bytes_read);
            continue;
        }
        if (existing_for_feed < 0) existing_for_feed = static_cast<ssize_t>(data.feed_info.size());
        seen_in_file = true;
        data.feed_info.push_back(f);
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

void load_feeds(GTFSData& data, const std::vector<BufferView>& zip_buffers, const std::vector<std::string>& feed_ids, int merge_strategy, LogFn log, ProgressFn progress, const std::vector<std::string>& files_to_load = {}, uint64_t max_zip_entry_bytes = MAX_ZIP_ENTRY_BYTES) {
    data.clear();

    std::unordered_map<uint64_t, std::vector<StopTime>> merged_stop_times;
    std::unordered_map<uint64_t, std::vector<Shape>> merged_shapes;

    // Build effective file filter (empty = load all)
    const std::vector<std::string> all_target_files = {
        "agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt",
        "calendar.txt", "calendar_dates.txt", "transfers.txt", "frequencies.txt", "shapes.txt", "feed_info.txt",
        "occupancies.txt"
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
            if (log) log("Failed to init zip reader for feed " + current_feed_id);
            throw std::runtime_error("Failed to init zip reader for feed " + current_feed_id + " (invalid or truncated archive)");
        }

        int64_t total_uncompressed_size = 0;
        int file_count = mz_zip_reader_get_num_files(&zip_archive);
        if (file_count < 0 || static_cast<size_t>(file_count) > MAX_ZIP_ENTRIES) {
            mz_zip_reader_end(&zip_archive);
            throw std::runtime_error("GTFS archive contains too many entries");
        }

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

            if (file_contents.count(filename)) {
                mz_zip_reader_end(&zip_archive);
                throw std::runtime_error("GTFS archive contains duplicate entry " + filename);
            }

            size_t uncomp_size = static_cast<size_t>(file_stat.m_uncomp_size);
            const uint64_t compressed_size = static_cast<uint64_t>(file_stat.m_comp_size);
            if (uncomp_size > max_zip_entry_bytes ||
                static_cast<uint64_t>(total_uncompressed_size) + uncomp_size > MAX_ZIP_TOTAL_BYTES ||
                (uncomp_size > 0 && (compressed_size == 0 || uncomp_size / compressed_size > MAX_ZIP_COMPRESSION_RATIO))) {
                mz_zip_reader_end(&zip_archive);
                throw std::runtime_error("GTFS archive entry exceeds extraction limits: " + filename);
            }
            std::vector<char> buf(uncomp_size);
            if (!mz_zip_reader_extract_to_mem(&zip_archive, i, buf.data(), uncomp_size, 0)) {
                mz_zip_reader_end(&zip_archive);
                throw std::runtime_error("Failed to extract GTFS archive entry " + filename);
            }
            total_uncompressed_size += static_cast<int64_t>(uncomp_size);
            file_contents.emplace(filename, std::move(buf));
        }
        mz_zip_reader_end(&zip_archive);

        if (files_to_load.empty()) {
            for (const char* required : {"agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt"}) {
                if (!file_contents.count(required)) throw std::runtime_error(std::string("GTFS archive is missing required file ") + required);
            }
            if (!file_contents.count("calendar.txt") && !file_contents.count("calendar_dates.txt")) {
                throw std::runtime_error("GTFS archive must contain calendar.txt or calendar_dates.txt");
            }
        } else {
            for (const auto& requested : target_files) {
                if (!file_contents.count(requested)) throw std::runtime_error("GTFS archive is missing requested file " + requested);
            }
        }

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

        std::vector<std::future<size_t>> futures;
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
        if (file_contents.count("occupancies.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_occupancies, "occupancies.txt"));
        if (file_contents.count("transfers.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_transfers, "transfers.txt"));
        if (file_contents.count("frequencies.txt"))
            futures.push_back(std::async(std::launch::async, process_file, parse_frequencies, "frequencies.txt"));
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
                const auto stop_times_started = std::chrono::steady_clock::now();

                const char* content_data = content_vec.data();
                size_t content_size = content_vec.size();

                // Parse a logical CSV record so quoted newlines remain part of a field.
                const char* header_start = nullptr;
                size_t header_len = 0;
                const char* after_header = advance_line(content_data, content_data + content_size, header_start, header_len);
                if (header_len == 0) return 0;
                std::string header_line(header_start, header_len);
                remove_bom(header_line);
                auto headers = parse_csv_line(header_line);
                require_columns(headers, {"trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"}, "stop_times.txt");

                size_t start_pos = static_cast<size_t>(after_header - content_data);
                if (start_pos >= content_size) return 0;

                processed_bytes.fetch_add(static_cast<int64_t>(start_pos));

                size_t data_size = content_size - start_pos;

                // Cap thread count at eight and avoid spawning one task per
                // tiny fixture/file. Large stop_times files still use the
                // available workers, with roughly 256 KiB per chunk.
                unsigned int thread_count = std::thread::hardware_concurrency();
                if (thread_count == 0) thread_count = 4;
                if (thread_count > 8) thread_count = 8;
                if (memchr(content_data + start_pos, '"', data_size)) thread_count = 1;
                constexpr size_t TARGET_CHUNK_BYTES = 256 * 1024;
                const size_t size_based_threads = std::max<size_t>(
                    1, (data_size + TARGET_CHUNK_BYTES - 1) / TARGET_CHUNK_BYTES);
                thread_count = static_cast<unsigned int>(std::min<size_t>(thread_count, size_based_threads));

                size_t chunk_size = (data_size + thread_count - 1) / thread_count;

                std::vector<std::future<std::vector<StopTime>>> chunk_futures;
                size_t current_pos = start_pos;

                for (unsigned int i = 0; i < thread_count; ++i) {
                    if (current_pos >= content_size) break;

                    size_t end_pos = (i == thread_count - 1)
                        ? content_size
                        : std::min(content_size, current_pos + chunk_size);
                    if (end_pos < content_size) {
                        // Advance to the next newline boundary.
                        const char* search_start = content_data + end_pos;
                        size_t remaining = content_size - end_pos;
                        const char* next_nl = static_cast<const char*>(memchr(search_start, '\n', remaining));
                        end_pos = next_nl ? static_cast<size_t>(next_nl - content_data) + 1 : content_size;
                    }

                    if (end_pos <= current_pos) {
                        end_pos = content_size;
                    }

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
                    const uint64_t qualified_id = (static_cast<uint64_t>(current_feed_id_int) << 32) | tid;
                    if (merge_strategy == 1 && merged_stop_times.count(qualified_id)) continue;
                    if (merge_strategy == 2 && merged_stop_times.count(qualified_id)) {
                        throw std::runtime_error("Duplicate trip_id in stop_times: " + current_feed_id + "/" + data.string_pool.get(tid));
                    }

                    std::sort(vec.begin(), vec.end(), [](const StopTime& a, const StopTime& b) {
                        return a.stop_sequence < b.stop_sequence;
                    });
                    for (size_t index = 1; index < vec.size(); ++index) {
                        if (vec[index].stop_sequence == vec[index - 1].stop_sequence) {
                            throw std::runtime_error("Duplicate stop_sequence in stop_times: " + current_feed_id + "/" + data.string_pool.get(tid));
                        }
                    }
                    merged_stop_times[qualified_id] = std::move(vec);
                }

                if (log) {
                    const double stop_times_ms = std::chrono::duration<double, std::milli>(
                        std::chrono::steady_clock::now() - stop_times_started
                    ).count();
                    log("Parsed stop_times.txt in " + std::to_string(stop_times_ms) + "ms (" +
                        std::to_string(total_count) + " records)");
                }
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

    const auto finalization_started = std::chrono::steady_clock::now();
    if (log) log("All feeds loaded. Finalizing data...");

    size_t total_shapes = 0;
    for (const auto& [id, vec] : merged_shapes) {
        total_shapes += vec.size();
    }
    data.shapes.reserve(total_shapes);
    data.shape_ranges_by_id.reserve(merged_shapes.size());

    for (auto& [id, vec] : merged_shapes) {
        const size_t begin = data.shapes.size();
        const uint32_t shape_id = vec.empty() ? 0xFFFFFFFF : vec.front().shape_id;
        data.shapes.insert(
            data.shapes.end(),
            std::make_move_iterator(vec.begin()),
            std::make_move_iterator(vec.end())
        );
        if (shape_id != 0xFFFFFFFF) {
            data.shape_ranges_by_id[shape_id].push_back({begin, data.shapes.size()});
        }
    }

    size_t total_st = 0;
    std::vector<uint64_t> sorted_stop_time_keys;
    sorted_stop_time_keys.reserve(merged_stop_times.size());
    for (const auto& [key, vec] : merged_stop_times) {
        total_st += vec.size();
        sorted_stop_time_keys.push_back(key);
    }
    // The packed key puts feed_id before trip_id, matching the former row sort.
    std::sort(sorted_stop_time_keys.begin(), sorted_stop_time_keys.end());

    data.stop_times.reserve(total_st);
    data.stop_times_by_trip_id.reserve(sorted_stop_time_keys.size());

    if (log) log("Appending and indexing stop times...");
    for (const uint64_t key : sorted_stop_time_keys) {
        auto stop_times_it = merged_stop_times.find(key);
        if (stop_times_it == merged_stop_times.end()) continue;

        auto& vec = stop_times_it->second;
        data.stop_times.insert(
            data.stop_times.end(),
            std::make_move_iterator(vec.begin()),
            std::make_move_iterator(vec.end())
        );
    }
    data.rebuildStopTimeIndexes();

    if (log && !data.static_occupancies.empty()) log("Indexing static occupancies by trip_id...");
    for (size_t i = 0; i < data.static_occupancies.size(); ++i) {
        data.static_occupancies_by_trip_id[data.static_occupancies[i].trip_id].push_back(i);
    }

    // Build trip indexes after parsing, when the feed maps will no longer mutate.
    if (log) log("Building trip query indexes...");
    for (const auto& [feed_id, feed_map] : data.trips) {
        for (const auto& [trip_id, trip] : feed_map) {
            data.trips_by_route_id[feed_id][trip.route_id].push_back(&trip);
            data.trips_by_service_id[feed_id][trip.service_id].push_back(&trip);
            if (trip.block_id != ST_NO_HEADSIGN) {
                data.trips_by_block_id[feed_id][trip.block_id].push_back(&trip);
            }
        }
    }

    if (log) {
        const double finalization_ms = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - finalization_started
        ).count();
        log("Finalized data in " + std::to_string(finalization_ms) + "ms (" +
            std::to_string(data.stop_times.size()) + " stop-time rows)");
        log("GTFS Data Loading Complete.");
    }
}


} 
