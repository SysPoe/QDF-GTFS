#include "GTFS.h"
#include "miniz.h"
#include <sstream>
#include <algorithm>
#include <string.h>
#include <cstdio>
#include <functional>
#include <thread>
#include <future>
#include <vector>
#include <atomic>
#include <unordered_set>

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
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    try {
        return std::stoi(val);
    } catch (...) {
        return default_val;
    }
}

double get_double(const std::vector<std::string>& row, int index, double default_val = 0.0) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    try {
        return std::stod(val);
    } catch (...) {
        return default_val;
    }
}

bool get_bool(const std::vector<std::string>& row, int index, bool default_val = false) {
    std::string val = get_val(row, index);
    if (val.empty()) return default_val;
    return val == "1";
}


size_t parse_agency(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "agency_id");
    int name_idx = get_col_index(headers, "agency_name");
    int url_idx = get_col_index(headers, "agency_url");
    int tz_idx = get_col_index(headers, "agency_timezone");
    int lang_idx = get_col_index(headers, "agency_lang");
    int phone_idx = get_col_index(headers, "agency_phone");
    int fare_url_idx = get_col_index(headers, "agency_fare_url");
    int email_idx = get_col_index(headers, "agency_email");

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Agency a;
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

        // Use agency_id if present, otherwise fall back to agency_name as key
        std::string key = a.agency_id.has_value() ? a.agency_id.value() : a.agency_name;
        if (!a.agency_id.has_value()) a.agency_id = key; // ensure a usable id exists

        if (merge_strategy == 1 && data.agencies.count(key)) continue; // IGNORE
        if (merge_strategy == 2 && data.agencies.count(key)) throw std::runtime_error("Duplicate agency: " + key); // THROW

        data.agencies[key] = a;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_routes(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
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

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Route r;
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


        if (merge_strategy == 1 && data.routes.count(r.route_id)) continue; 
        if (merge_strategy == 2 && data.routes.count(r.route_id)) throw std::runtime_error("Duplicate route: " + r.route_id); 

        data.routes[r.route_id] = r;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_trips(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
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

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Trip t;
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


        if (merge_strategy == 1 && data.trips.count(t.trip_id)) continue; 
        if (merge_strategy == 2 && data.trips.count(t.trip_id)) throw std::runtime_error("Duplicate trip: " + t.trip_id); 

        data.trips[t.trip_id] = t;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_stops(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
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

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Stop s;
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


        if (merge_strategy == 1 && data.stops.count(s.stop_id)) continue; 
        if (merge_strategy == 2 && data.stops.count(s.stop_id)) throw std::runtime_error("Duplicate stop: " + s.stop_id); 

        data.stops[s.stop_id] = s;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}


// Updated to output to a specific vector, useful for multithreading
size_t parse_stop_times_chunk(StringPool& string_pool, const char* start, size_t length, const std::vector<std::string>& headers, std::vector<StopTime>& out_vec, const std::function<void(size_t)>& on_progress = nullptr) {
    std::string content(start, length);
    std::stringstream ss(content);
    std::string line;

    remove_bom(line);

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

    size_t count = 0;
    while (std::getline(ss, line)) {

        bytes_read += line.size() + 1;
        if (line.empty()) continue;

        auto row = parse_csv_line(line);
        StopTime st;
        std::string tmp;
        st.trip_id = string_pool.intern(get_val(row, trip_id_idx));
        tmp = get_val(row, arrival_idx);
        {
            int t = parse_time_seconds(tmp);
            if (t != -1) st.arrival_time = t;
        }
        tmp = get_val(row, departure_idx);
        {
            int t = parse_time_seconds(tmp);
            if (t != -1) st.departure_time = t;
        }
        st.stop_id = string_pool.intern(get_val(row, stop_id_idx));
        st.stop_sequence = get_int(row, seq_idx);
        tmp = get_val(row, headsign_idx);
        if (!tmp.empty()) st.stop_headsign = string_pool.intern(tmp);
        st.pickup_type = get_int(row, pickup_idx);
        st.drop_off_type = get_int(row, drop_off_idx);
        tmp = get_val(row, dist_idx);
        if (!tmp.empty()) st.shape_dist_traveled = get_double(row, dist_idx);
        tmp = get_val(row, timepoint_idx);
        if (!tmp.empty()) st.timepoint = get_int(row, timepoint_idx);
        tmp = get_val(row, cont_pickup_idx);
        if (!tmp.empty()) st.continuous_pickup = get_int(row, cont_pickup_idx);
        tmp = get_val(row, cont_drop_off_idx);
        if (!tmp.empty()) st.continuous_drop_off = get_int(row, cont_drop_off_idx);
        out_vec.push_back(st);
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read - last_report);
    return count;
}

size_t parse_calendar(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
    int service_id_idx = get_col_index(headers, "service_id");
    int mon_idx = get_col_index(headers, "monday");
    int tue_idx = get_col_index(headers, "tuesday");
    int wed_idx = get_col_index(headers, "wednesday");
    int thu_idx = get_col_index(headers, "thursday");
    int fri_idx = get_col_index(headers, "friday");
    int sat_idx = get_col_index(headers, "saturday");
    int sun_idx = get_col_index(headers, "sunday");
    int start_idx = get_col_index(headers, "start_date");
    int end_idx = get_col_index(headers, "end_date");

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Calendar c;
        c.service_id = get_val(row, service_id_idx);
        c.monday = get_bool(row, mon_idx);
        c.tuesday = get_bool(row, tue_idx);
        c.wednesday = get_bool(row, wed_idx);
        c.thursday = get_bool(row, thu_idx);
        c.friday = get_bool(row, fri_idx);
        c.saturday = get_bool(row, sat_idx);
        c.sunday = get_bool(row, sun_idx);
        c.start_date = get_val(row, start_idx);
        c.end_date = get_val(row, end_idx);


        if (merge_strategy == 1 && data.calendars.count(c.service_id)) continue; 
        if (merge_strategy == 2 && data.calendars.count(c.service_id)) throw std::runtime_error("Duplicate calendar: " + c.service_id); 

        data.calendars[c.service_id] = c;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_calendar_dates(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
    int service_id_idx = get_col_index(headers, "service_id");
    int date_idx = get_col_index(headers, "date");
    int exc_idx = get_col_index(headers, "exception_type");

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        std::string service_id = get_val(row, service_id_idx);
        std::string date = get_val(row, date_idx);
        int exc = get_int(row, exc_idx);


        if (merge_strategy == 1 && data.calendar_dates.count(service_id) && data.calendar_dates[service_id].count(date)) continue;
        if (merge_strategy == 2 && data.calendar_dates.count(service_id) && data.calendar_dates[service_id].count(date)) {
            throw std::runtime_error("Duplicate calendar_date: " + service_id + "/" + date);
        }

        data.calendar_dates[service_id][date] = exc;
        count++;
        report_progress(bytes_read);
    }
    if (on_progress && bytes_read > last_report) on_progress(bytes_read);
    return count;
}

size_t parse_shapes(GTFSData& data, std::unordered_map<std::string, std::vector<Shape>>& merged_shapes, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {
    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
    int id_idx = get_col_index(headers, "shape_id");
    int lat_idx = get_col_index(headers, "shape_pt_lat");
    int lon_idx = get_col_index(headers, "shape_pt_lon");
    int seq_idx = get_col_index(headers, "shape_pt_sequence");
    int dist_idx = get_col_index(headers, "shape_dist_traveled");


    std::unordered_map<std::string, std::vector<Shape>> feed_shapes;

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        Shape s;
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

size_t parse_feed_info(GTFSData& data, const std::string& content, int merge_strategy, const std::function<void(size_t)>& on_progress = nullptr) {

    (void)merge_strategy;

    std::stringstream ss(content);
    std::string line;
    std::getline(ss, line);
    if (line.empty()) return 0;

    remove_bom(line);

    size_t bytes_read = line.size() + 1;
    size_t last_report = 0;
    auto report_progress = [&](size_t bytes) {
        if (on_progress && bytes - last_report >= PROGRESS_CHUNK_BYTES) {
            on_progress(bytes);
            last_report = bytes;
        }
    };
    report_progress(bytes_read);

    auto headers = parse_csv_line(line);
    int pub_name_idx = get_col_index(headers, "feed_publisher_name");
    int pub_url_idx = get_col_index(headers, "feed_publisher_url");
    int lang_idx = get_col_index(headers, "feed_lang");
    int def_lang_idx = get_col_index(headers, "default_lang");
    int start_idx = get_col_index(headers, "feed_start_date");
    int end_idx = get_col_index(headers, "feed_end_date");
    int ver_idx = get_col_index(headers, "feed_version");
    int email_idx = get_col_index(headers, "feed_contact_email");
    int contact_url_idx = get_col_index(headers, "feed_contact_url");

    size_t count = 0;
    while (std::getline(ss, line)) {
        bytes_read += line.size() + 1;
        if (line.empty()) continue;
        auto row = parse_csv_line(line);
        FeedInfo f;
        std::string tmp;
        f.feed_publisher_name = get_val(row, pub_name_idx);
        f.feed_publisher_url = get_val(row, pub_url_idx);
        f.feed_lang = get_val(row, lang_idx);
        tmp = get_val(row, def_lang_idx);
        if (!tmp.empty()) f.default_lang = tmp;
        tmp = get_val(row, start_idx);
        if (!tmp.empty()) f.feed_start_date = tmp;
        tmp = get_val(row, end_idx);
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

void load_feeds(GTFSData& data, const std::vector<std::vector<unsigned char>>& zip_buffers, int merge_strategy, LogFn log, ProgressFn progress) {
    data.clear();

    std::unordered_map<uint32_t, std::vector<StopTime>> merged_stop_times;
    std::unordered_map<std::string, std::vector<Shape>> merged_shapes;

    int feed_idx = 0;
    for (const auto& zip_data : zip_buffers) {
        feed_idx++;
        if (log) log("Processing feed " + std::to_string(feed_idx) + "...");

        mz_zip_archive zip_archive;
        memset(&zip_archive, 0, sizeof(zip_archive));

        if (!mz_zip_reader_init_mem(&zip_archive, zip_data.data(), zip_data.size(), 0)) {
            if (log) log("Failed to init zip reader for feed " + std::to_string(feed_idx));
            std::cerr << "Failed to init zip reader" << std::endl;
            continue;
        }


        int64_t total_uncompressed_size = 0;
        int file_count = mz_zip_reader_get_num_files(&zip_archive);

        std::vector<std::string> target_files = {
            "agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt",
            "calendar.txt", "calendar_dates.txt", "shapes.txt", "feed_info.txt"
        };

        std::unordered_map<std::string, std::string> file_contents;

        for (int i = 0; i < file_count; i++) {
            mz_zip_archive_file_stat file_stat;
            if (!mz_zip_reader_file_stat(&zip_archive, i, &file_stat)) continue;

            std::string filename = file_stat.m_filename;
            bool is_target = false;
            for(const auto& tf : target_files) {
                 if (tf == filename) {
                     is_target = true;
                     break;
                 }
            }
            if (!is_target) continue;

            size_t uncomp_size = file_stat.m_uncomp_size;
            void* p = mz_zip_reader_extract_file_to_heap(&zip_archive, filename.c_str(), &uncomp_size, 0);
            if (p) {
                file_contents[filename] = std::string((char*)p, uncomp_size);
                mz_free(p);
                total_uncompressed_size += uncomp_size;
            }
        }
        mz_zip_reader_end(&zip_archive);


        std::vector<std::future<size_t>> futures;
        std::atomic<int64_t> processed_bytes(0);

        auto process_file = [&](auto parser_func, const std::string& filename) -> size_t {
            if (file_contents.find(filename) == file_contents.end()) return 0;
            const std::string& content = file_contents[filename];
            auto inline_progress = [&](size_t file_bytes_done) {
                if (!progress) return;
                int64_t current = processed_bytes.load(std::memory_order_relaxed) + static_cast<int64_t>(file_bytes_done);
                if (current > total_uncompressed_size) current = total_uncompressed_size;
                progress("Loading GTFS Data (Feed " + std::to_string(feed_idx) + ")", current, total_uncompressed_size);
            };

            size_t count = parser_func(data, content, merge_strategy, inline_progress);

            int64_t current = processed_bytes.fetch_add(content.size()) + content.size();
            if (progress) progress("Loading GTFS Data (Feed " + std::to_string(feed_idx) + ")", current, total_uncompressed_size);
            if (log) log("Loaded " + std::to_string(count) + " entries from " + filename);
            return count;
        };

        auto process_shapes_file = [&](const std::string& filename) -> size_t {
            if (file_contents.find(filename) == file_contents.end()) return 0;
            const std::string& content = file_contents[filename];
             auto inline_progress = [&](size_t file_bytes_done) {
                if (!progress) return;
                int64_t current = processed_bytes.load(std::memory_order_relaxed) + static_cast<int64_t>(file_bytes_done);
                if (current > total_uncompressed_size) current = total_uncompressed_size;
                progress("Loading GTFS Data (Feed " + std::to_string(feed_idx) + ")", current, total_uncompressed_size);
            };
            size_t count = parse_shapes(data, merged_shapes, content, merge_strategy, inline_progress);
             int64_t current = processed_bytes.fetch_add(content.size()) + content.size();
            if (progress) progress("Loading GTFS Data (Feed " + std::to_string(feed_idx) + ")", current, total_uncompressed_size);
            if (log) log("Loaded " + std::to_string(count) + " entries from " + filename);
            return count;
        };

        if (file_contents.count("agency.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_agency, "agency.txt"));
        }
        if (file_contents.count("routes.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_routes, "routes.txt"));
        }
        if (file_contents.count("trips.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_trips, "trips.txt"));
        }
        if (file_contents.count("stops.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_stops, "stops.txt"));
        }
        if (file_contents.count("calendar.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_calendar, "calendar.txt"));
        }
        if (file_contents.count("calendar_dates.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_calendar_dates, "calendar_dates.txt"));
        }
        if (file_contents.count("shapes.txt")) {
             futures.push_back(std::async(std::launch::async, process_shapes_file, "shapes.txt"));
        }
        if (file_contents.count("feed_info.txt")) {
            futures.push_back(std::async(std::launch::async, process_file, parse_feed_info, "feed_info.txt"));
        }

        std::future<size_t> stop_times_future;
        if (file_contents.count("stop_times.txt")) {
            stop_times_future = std::async(std::launch::async,
                [&data, &file_contents, progress, log, total_uncompressed_size, &processed_bytes, &merged_stop_times, merge_strategy, feed_idx]() -> size_t {
                const std::string& content = file_contents["stop_times.txt"];
                if (content.empty()) return 0;

                size_t header_end = content.find('\n');
                if (header_end == std::string::npos) return 0;
                std::string header_line = content.substr(0, header_end);
                remove_bom(header_line);
                auto headers = parse_csv_line(header_line);

                size_t start_pos = header_end + 1;
                size_t total_length = content.length();
                if (start_pos >= total_length) return 0;

                processed_bytes.fetch_add(header_end + 1);

                unsigned int thread_count = std::thread::hardware_concurrency();
                if (thread_count == 0) thread_count = 4;

                size_t data_size = total_length - start_pos;
                size_t chunk_size = data_size / thread_count;

                std::vector<std::future<std::vector<StopTime>>> chunk_futures;
                size_t current_pos = start_pos;

                for (unsigned int i = 0; i < thread_count; ++i) {
                    size_t end_pos = current_pos + chunk_size;
                    if (i == thread_count - 1) {
                        end_pos = total_length;
                    } else {
                        size_t next_newline = content.find('\n', end_pos);
                        if (next_newline != std::string::npos) {
                            end_pos = next_newline + 1;
                        } else {
                            end_pos = total_length;
                        }
                    }

                    if (current_pos >= total_length) break;

                    size_t len = end_pos - current_pos;
                    const char* ptr = content.data() + current_pos;

                    chunk_futures.push_back(std::async(std::launch::async,
                        [ptr, len, headers, &data, &processed_bytes, progress, total_uncompressed_size, feed_idx]() {
                            std::vector<StopTime> vec;
                            vec.reserve(len / 50);

                            auto chunk_progress = [&](size_t delta_bytes) {
                                int64_t current = processed_bytes.fetch_add(static_cast<int64_t>(delta_bytes)) + static_cast<int64_t>(delta_bytes);
                                if (progress) {
                                    if (current > total_uncompressed_size) current = total_uncompressed_size;
                                    progress("Loading GTFS Data (Feed " + std::to_string(feed_idx) + ")", current, total_uncompressed_size);
                                }
                            };

                            parse_stop_times_chunk(data.string_pool, ptr, len, headers, vec, chunk_progress);
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
                    for(auto& st : chunk_vec) {
                        current_feed_stop_times[st.trip_id].push_back(std::move(st));
                    }
                }


                for(auto& [tid, vec] : current_feed_stop_times) {
                     if (merge_strategy == 1 && merged_stop_times.count(tid)) continue;
                     if (merge_strategy == 2 && merged_stop_times.count(tid)) {

                        throw std::runtime_error("Duplicate trip_id in stop_times: " + data.string_pool.get(tid));
                     }

                     std::sort(vec.begin(), vec.end(), [](const StopTime& a, const StopTime& b){
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

    } 

    if (log) log("All feeds loaded. Finalizing data...");


    for(auto& [id, vec] : merged_shapes) {
        data.shapes.insert(data.shapes.end(), vec.begin(), vec.end());
    }


    size_t total_st = 0;
    for(const auto& [tid, vec] : merged_stop_times) {
        total_st += vec.size();
    }
    data.stop_times.reserve(total_st);

    for(auto& [tid, vec] : merged_stop_times) {
        data.stop_times.insert(data.stop_times.end(), vec.begin(), vec.end());
    }

    if (log) log("Sorting stop times...");
    std::sort(data.stop_times.begin(), data.stop_times.end(),
        [](const StopTime& a, const StopTime& b) {
            if (a.trip_id != b.trip_id) {
                return a.trip_id < b.trip_id;
            }
            return a.stop_sequence < b.stop_sequence;
        });

    if (log) log("Indexing stop times by stop_id...");
    for (size_t i = 0; i < data.stop_times.size(); ++i) {
        data.stop_times_by_stop_id[data.stop_times[i].stop_id].push_back(i);
    }

    if (log) log("GTFS Data Loading Complete.");
}


} 
